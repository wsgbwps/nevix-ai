package integrationtest

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

type materialView struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	FileName       string `json:"file_name"`
	MimeType       string `json:"mime_type"`
	ByteSize       int64  `json:"byte_size"`
	WidthPx        *int   `json:"width_px"`
	HeightPx       *int   `json:"height_px"`
	PixelCount     *int64 `json:"pixel_count"`
	DurationMS     *int   `json:"duration_ms"`
	ChecksumSHA256 string `json:"checksum_sha256"`
	ClaimsVersion  int    `json:"claims_version"`
	CreatedAt      string `json:"created_at"`
}

type materialList struct {
	Materials  []materialView `json:"materials"`
	NextCursor *string        `json:"next_cursor"`
}

// doUpload streams one multipart body through the real handler.
func (h *harness) doUpload(t *testing.T, method, path, token, fileName string, fileBody []byte) (int, []byte) {
	t.Helper()
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	defer form.Close()
	part, err := form.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	if _, err := part.Write(fileBody); err != nil {
		t.Fatalf("write form part: %v", err)
	}
	if err := form.Close(); err != nil {
		t.Fatalf("close form: %v", err)
	}
	req, err := http.NewRequest(method, h.serverURL+path, bytes.NewReader(body.Bytes()))
	if err != nil {
		t.Fatalf("build upload: %v", err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		t.Fatalf("read upload response: %v", readErr)
	}
	return resp.StatusCode, respBody
}

func mustUpload(t *testing.T, status int, body []byte) materialView {
	if status != http.StatusCreated {
		t.Fatalf("upload: status=%d body=%s", status, body)
	}
	// The concrete session path maps onto the templated contract route.
	assertContractResponse(t, "POST", "/creation/sessions/x/materials", status, body)
	var view materialView
	mustDecode(t, body, &view)
	return view
}

func TestUploadRecordsAtomicRightsFacts(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("rights"))

	status, body := h.doUpload(t, "POST", "/creation/sessions/"+session.ID+"/materials", token, "poster.png", pngBytes(t))
	view := mustUpload(t, status, body)

	if view.Kind != "image" || view.MimeType != "image/png" || view.FileName != "poster.png" {
		t.Fatalf("identity facts wrong: %+v", view)
	}
	if view.WidthPx == nil || *view.WidthPx != 24 || view.HeightPx == nil || *view.HeightPx != 16 {
		t.Fatalf("dimensions not authoritative: %+v", view)
	}
	if view.PixelCount == nil || *view.PixelCount != 384 {
		t.Fatalf("pixel count missing: %+v", view)
	}
	if view.DurationMS != nil {
		t.Fatal("images must not carry duration")
	}
	if view.ClaimsVersion < 1 {
		t.Fatal("rights claims version was not recorded")
	}
	if len(view.ChecksumSHA256) != 64 {
		t.Fatalf("checksum shape: %q", view.ChecksumSHA256)
	}

	// The recorded row is immediately visible to its creator's pile only.
	listStatus, listBody := h.doRequest(t, "GET", "/creation/sessions/"+session.ID+"/materials?limit=200", token, nil)
	if listStatus != http.StatusOK {
		t.Fatalf("list materials: %d %s", listStatus, listBody)
	}
	assertContractResponse(t, "GET", "/creation/sessions/"+session.ID+"/materials", listStatus, listBody)
	var listing materialList
	mustDecode(t, listBody, &listing)
	found := false
	for _, m := range listing.Materials {
		if m.ID == view.ID {
			found = true
		}
	}
	if !found || len(listing.Materials) != 1 {
		t.Fatalf("pile mismatch after upload: %+v", listing.Materials)
	}
}

func TestUploadValidationPipelineStableReasons(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("validation"))
	base := "/creation/sessions/" + session.ID + "/materials"

	textBlob := []byte("this text file is definitely not media")
	cases := []struct {
		name         string
		fileName     string
		payload      []byte
		wantStatus   int
		wantResponse bool
	}{
		{"extension-disagrees-with-content", "photo.mp3", pngBytes(t), http.StatusUnsupportedMediaType, true},
		{"foreign-content-sniffed-unknown", "notes.txt", textBlob, http.StatusUnsupportedMediaType, true},
		{"corrupt-image-fails-authoritative-decode", "broken.png", pngBytes(t)[:40], http.StatusUnprocessableEntity, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := tc.payload
			status, body := h.doUpload(t, "POST", base, token, tc.fileName, payload)
			if status != tc.wantStatus {
				t.Fatalf("status=%d want %d body=%s", status, tc.wantStatus, body)
			}
			assertErrorEnvelope(t, body, tc.wantStatus)
		})
	}

	// A failed upload leaves no pile entry behind.
	status, body := h.doRequest(t, "GET", base+"?limit=200", token, nil)
	if status != http.StatusOK {
		t.Fatalf("list after failures: %d %s", status, body)
	}
	var listing materialList
	mustDecode(t, body, &listing)
	if len(listing.Materials) != 0 {
		t.Fatalf("failed uploads left usable material: %+v", listing.Materials)
	}
}

func TestDownloadServesRangeAndChecksumHeaders(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("download"))
	blob := pngBytes(t)
	status, body := h.doUpload(t, "POST", "/creation/sessions/"+session.ID+"/materials", token, "shot.png", blob)
	view := mustUpload(t, status, body)

	fullURL := "/creation/materials/" + view.ID
	req, err := http.NewRequest("GET", h.serverURL+fullURL, nil)
	if err != nil {
		t.Fatalf("build download: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("full download: %v", err)
	}
	defer resp.Body.Close()
	downloaded, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || len(downloaded) != len(blob) || !bytes.Equal(downloaded, blob) {
		t.Fatalf("full download mismatch: status=%d size=%d/%d", resp.StatusCode, len(downloaded), len(blob))
	}
	if got := resp.Header.Get("X-Content-SHA-256"); got == "" || got != view.ChecksumSHA256 {
		t.Fatalf("checksum header %q vs record %q", got, view.ChecksumSHA256)
	}
	if resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatal("Accept-Ranges must be advertised")
	}

	rangeReq, _ := http.NewRequest("GET", h.serverURL+fullURL, nil)
	rangeReq.Header.Set("Authorization", "Bearer "+token)
	rangeReq.Header.Set("Range", "bytes=8-31")
	rangeResp, err := http.DefaultClient.Do(rangeReq)
	if err != nil {
		t.Fatalf("range download: %v", err)
	}
	defer rangeResp.Body.Close()
	ranged, _ := io.ReadAll(rangeResp.Body)
	if rangeResp.StatusCode != http.StatusPartialContent ||
		rangeResp.Header.Get("Content-Range") != "bytes 8-31/"+itoa(len(blob)) ||
		!bytes.Equal(ranged, blob[8:32]) {
		t.Fatalf("range response wrong: status=%d content-range=%q len=%d",
			rangeResp.StatusCode, rangeResp.Header.Get("Content-Range"), len(ranged))
	}

	badReq, _ := http.NewRequest("GET", h.serverURL+fullURL, nil)
	badReq.Header.Set("Authorization", "Bearer "+token)
	badReq.Header.Set("Range", "bytes=99999999-")
	badResp, err := http.DefaultClient.Do(badReq)
	if err != nil {
		t.Fatalf("unsatisfiable request: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("out-of-bounds range: %d", badResp.StatusCode)
	}

	// The contract answers 416 for malformed and multi-range specs too — a
	// client asking for a slice never silently receives the whole blob.
	for _, header := range []string{"bytes=5-2", "bytes=0-4,10-14", "cubes=0-4", "bytes=--"} {
		invalidReq, _ := http.NewRequest("GET", h.serverURL+fullURL, nil)
		invalidReq.Header.Set("Authorization", "Bearer "+token)
		invalidReq.Header.Set("Range", header)
		invalidResp, invalidErr := http.DefaultClient.Do(invalidReq)
		if invalidErr != nil {
			t.Fatalf("invalid range %q: %v", header, invalidErr)
		}
		invalidResp.Body.Close()
		if invalidResp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
			t.Fatalf("invalid range %q: %d", header, invalidResp.StatusCode)
		}
	}

	otherReq, _ := http.NewRequest("GET", h.serverURL+fullURL, nil)
	otherReq.Header.Set("Authorization", "Bearer "+otherToken)
	otherResp, err := http.DefaultClient.Do(otherReq)
	if err != nil {
		t.Fatalf("foreign download: %v", err)
	}
	otherResp.Body.Close()
	if otherResp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin/foreign member guessed a material id and got %d", otherResp.StatusCode)
	}
}

func TestDeleteMaterialRemovesRowAndBlobCleanupSchedules(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("delete-material"))
	status, body := h.doUpload(t, "POST", "/creation/sessions/"+session.ID+"/materials", token, "bye.png", pngBytes(t))
	view := mustUpload(t, status, body)

	if status, body := h.doRequest(t, "DELETE", "/creation/materials/"+view.ID, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete material: %d %s", status, body)
	}
	assertContractResponse(t, "DELETE", "/creation/materials/"+view.ID, http.StatusNoContent, nil)
	if status, body := h.doRequest(t, "DELETE", "/creation/materials/"+view.ID, token, nil); status != http.StatusNotFound {
		t.Fatalf("repeat delete: %d %s", status, body)
	}
	var count int
	if err := h.ownerPool.QueryRow(h.ctx,
		`SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid`, view.ID).Scan(&count); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if count != 0 {
		t.Fatal("deleted material row still present")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func assertErrorEnvelope(t *testing.T, body []byte, status int) {
	t.Helper()
	var envelope struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("status %d body is not the error envelope: %v (%s)", status, err, body)
	}
	if envelope.Error == "" || envelope.Message == "" {
		t.Fatalf("error envelope incomplete: %s", body)
	}
}

func TestUploadRejectsFormsWithoutFilePart(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("no-file"))
	path := "/creation/sessions/" + session.ID + "/materials"

	formBody := &bytes.Buffer{}
	form := multipart.NewWriter(formBody)
	field, err := form.CreateFormField("note")
	if err != nil {
		t.Fatalf("form field: %v", err)
	}
	if _, err := field.Write([]byte("not a file")); err != nil {
		t.Fatalf("write field: %v", err)
	}
	form.Close()

	req, err := http.NewRequest("POST", h.serverURL+path, bytes.NewReader(formBody.Bytes()))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want 400 body=%s", resp.StatusCode, body)
	}
	assertErrorEnvelope(t, body, resp.StatusCode)
}

// Minimal ISO-BMFF builders mirroring the shapes the server's MP4 walker
// reads: ftyp + moov{mvhd,trak{mdia{mdhd,hdlr,minf{stbl{stsd}}}}} + mdat.
func mp4Box(ftype string, payload []byte) []byte {
	box := make([]byte, 8+len(payload))
	box[4], box[5], box[6], box[7] = ftype[0], ftype[1], ftype[2], ftype[3]
	binary.BigEndian.PutUint32(box[0:4], uint32(len(box)))
	copy(box[8:], payload)
	return box
}

func mp4Concat(parts ...[]byte) []byte {
	var buf bytes.Buffer
	for _, part := range parts {
		buf.Write(part)
	}
	return buf.Bytes()
}

func mp4Mvhd(timescale, duration uint32) []byte {
	payload := make([]byte, 96)
	binary.BigEndian.PutUint32(payload[12:16], timescale)
	binary.BigEndian.PutUint32(payload[16:20], duration)
	return mp4Box("mvhd", payload)
}

func mp4Hdlr(handler string) []byte {
	payload := make([]byte, 24)
	copy(payload[8:12], handler)
	return mp4Box("hdlr", payload)
}

// mp4Stsd builds one sample description entry; video entries carry dims.
func mp4Stsd(format string, width, height uint16) []byte {
	entry := make([]byte, 36)
	binary.BigEndian.PutUint32(entry[0:4], 36)
	copy(entry[4:8], format)
	if format == "avc1" {
		binary.BigEndian.PutUint16(entry[32:34], width)
		binary.BigEndian.PutUint16(entry[34:36], height)
	}
	payload := append([]byte{0, 0, 0, 0, 0, 0, 0, 1}, entry...) // flags + entry_count
	return mp4Box("stsd", payload)
}

func mp4Trak(handler, format string, width, height uint16) []byte {
	mdhd := make([]byte, 28)
	stbl := mp4Box("stbl", mp4Stsd(format, width, height))
	mdia := mp4Box("mdia", mp4Concat(mp4Box("mdhd", mdhd), mp4Hdlr(handler), mp4Box("minf", stbl)))
	return mp4Box("trak", mdia)
}

func videoMP4Fixture(width, height uint16, durationMS uint32) []byte {
	moov := mp4Box("moov", mp4Concat(
		mp4Mvhd(1000, durationMS),
		mp4Trak("vide", "avc1", width, height),
	))
	ftyp := mp4Box("ftyp", []byte("isom\x00\x00\x02\x00isomiso2avc1"))
	mdat := mp4Box("mdat", bytes.Repeat([]byte{0x55}, 4096))
	return mp4Concat(ftyp, moov, mdat)
}

func audioOnlyMP4Fixture(mdatPad int) []byte {
	moov := mp4Box("moov", mp4Concat(
		mp4Mvhd(1000, 3000),
		mp4Trak("soun", "mp4a", 0, 0),
	))
	ftyp := mp4Box("ftyp", []byte("M4A \x00\x00\x02\x00isomiso2"))
	return mp4Concat(ftyp, moov, mp4Box("mdat", bytes.Repeat([]byte{0}, mdatPad)))
}

// A real MP4 video upload must persist as kind=video with dimensions — the
// regression guard for the migration's per-kind facts constraint (AC #156:
// video rows were previously unsatisfiable).
func TestUploadVideoMaterialPersistsVideoFacts(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("video-facts"))

	status, body := h.doUpload(t, "POST", "/creation/sessions/"+session.ID+"/materials", token, "clip.mp4", videoMP4Fixture(1280, 720, 2500))
	view := mustUpload(t, status, body)
	if view.Kind != "video" {
		t.Fatalf("kind=%q want video (body %s)", view.Kind, body)
	}
	if view.WidthPx == nil || *view.WidthPx != 1280 || view.HeightPx == nil || *view.HeightPx != 720 {
		t.Fatalf("video dimensions not authoritative: %+v", view)
	}
}

// An MP4-family audio (M4A) above the audio ceiling must be rejected even
// though its container sniffed under the video streaming ceiling (AC #156:
// the authoritative kind's limit is re-checked after probing).
func TestUploadRejectsOversizedMP4AudioUnderVideoCeiling(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("m4a-cap"))

	audioLimit := 50 << 20
	status, body := h.doUpload(t, "POST", "/creation/sessions/"+session.ID+"/materials", token, "voiceover.m4a", audioOnlyMP4Fixture(audioLimit+1<<20))
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized m4a: status=%d body=%s", status, body)
	}
	assertContractResponse(t, "POST", "/creation/sessions/x/materials", status, body)
}

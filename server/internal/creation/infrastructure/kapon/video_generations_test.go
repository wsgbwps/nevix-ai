package kapon

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestVideoSubmitUsesNativeContract(t *testing.T) {
	var method, path, bearer string
	var body map[string]any
	client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, path, bearer = r.Method, r.URL.Path, r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode video submit: %v", err)
		}
		w.Write([]byte(`{"id":"native-video-task"}`))
	})
	ratio, resolution, duration := "16:9", "720p", 5
	outcome, err := client.Submit(context.Background(), "video-key", domain.PreparedSubmitRequest{
		Media: domain.MediaVideo, Model: domain.VideoModelID, Mode: domain.ModeTextToVideo,
		Prompt: "商品旋转展示", Quantity: 1, Ratio: &ratio, Resolution: &resolution, DurationS: &duration,
	})
	if err != nil || outcome.ExternalRef != "native-video-task" {
		t.Fatalf("native acceptance = %+v, %v", outcome, err)
	}
	if method != http.MethodPost || path != "/volcark/api/v3/contents/generations/tasks" || bearer != "Bearer video-key" {
		t.Fatalf("video submit = %s %s, auth=%q", method, path, bearer)
	}
	if body["model"] != "doubao-seedance-2-5" || body["resolution"] != "720p" ||
		body["ratio"] != "16:9" || body["duration"] != float64(5) ||
		body["generate_audio"] != true || body["output_format"] != "mp4" {
		t.Fatalf("native video parameters = %#v", body)
	}
	content, ok := body["content"].([]any)
	if !ok || len(content) != 1 || content[0].(map[string]any)["text"] != "商品旋转展示" {
		t.Fatalf("video prompt must remain exact: %#v", body["content"])
	}
}

func TestVideoSubmitPreservesNormalizedReferenceModes(t *testing.T) {
	tests := []struct {
		mode       string
		resolution string
		duration   int
		kinds      []domain.Kind
		roles      []domain.DraftRole
		wireRoles  []string
	}{
		{domain.ModeTextToVideo, "480p", 5, nil, nil, nil},
		{domain.ModeFirstFrame, "720p", 10, []domain.Kind{domain.KindImage}, []domain.DraftRole{domain.RoleFirstFrame}, []string{"first_frame"}},
		{domain.ModeFirstLastFrame, "1080p", 5, []domain.Kind{domain.KindImage, domain.KindImage}, []domain.DraftRole{domain.RoleFirstFrame, domain.RoleLastFrame}, []string{"first_frame", "last_frame"}},
		{domain.ModeOmniReference, "720p", 10, []domain.Kind{domain.KindImage, domain.KindVideo, domain.KindAudio}, []domain.DraftRole{domain.RoleOmni, domain.RoleOmni, domain.RoleOmni}, []string{"reference_image", "reference_video", "reference_audio"}},
	}
	for _, test := range tests {
		t.Run(test.mode, func(t *testing.T) {
			var body struct {
				Resolution string `json:"resolution"`
				Duration   int    `json:"duration"`
				Ratio      string `json:"ratio"`
				Content    []struct {
					Type  string               `json:"type"`
					Role  string               `json:"role"`
					Image struct{ URL string } `json:"image_url"`
					Video struct{ URL string } `json:"video_url"`
					Audio struct{ URL string } `json:"audio_url"`
				} `json:"content"`
			}
			client := newGenerationsClient(t, func(w http.ResponseWriter, r *http.Request) {
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Errorf("decode submit: %v", err)
				}
				w.Write([]byte(`{"id":"video-task"}`))
			})
			req := domain.PreparedSubmitRequest{Media: domain.MediaVideo, Model: domain.VideoModelID, Mode: test.mode, Prompt: "商品", Quantity: 1, Resolution: &test.resolution, DurationS: &test.duration}
			for i, kind := range test.kinds {
				req.References = append(req.References, domain.GatewayReference{
					Kind: kind, Role: test.roles[i], URL: "https://objects.example/" + string(kind) + "/" + test.wireRoles[i], ExpiresAt: time.Now().Add(time.Hour),
				})
			}
			if _, err := client.Submit(context.Background(), "k", req); err != nil {
				t.Fatalf("submit: %v", err)
			}
			if body.Resolution != test.resolution || body.Duration != test.duration || body.Ratio != "adaptive" || len(body.Content) != len(test.kinds)+1 {
				t.Fatalf("video parameters/reference count changed: %+v", body)
			}
			for i, kind := range test.kinds {
				item := body.Content[i+1]
				url := item.Image.URL + item.Video.URL + item.Audio.URL
				if item.Type != string(kind)+"_url" || item.Role != test.wireRoles[i] || url != req.References[i].URL {
					t.Fatalf("ordered reference %d changed: %+v", i, item)
				}
			}
		})
	}
}

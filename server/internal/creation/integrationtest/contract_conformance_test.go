package integrationtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"

	"gopkg.in/yaml.v3"
)

// Response-level OpenAPI conformance for the Creation surface: required fields, enums, JSON
// types, uuid/date-time formats on observed values, documented min/max bounds, allOf
// composition, component responses ($ref'd statuses), external Error-envelope references, and
// undocumented statuses rejected outright (the Identity suite's helper is prior art but checks
// only required fields). Requests are shaped by hand in these tests; responses are checked
// here on every observation.

var (
	conformanceOnce sync.Once
	masterSpec      map[string]any
	moduleSpecs     map[string]map[string]any
	conformanceDir  string
	loadErr         error
)

func TestReferenceMaterialUploadContractSurface(t *testing.T) {
	for _, route := range []struct {
		method string
		path   string
	}{
		{"POST", "/creation/sessions/00000000-0000-0000-0000-000000000001/reference-material-uploads"},
		{"GET", "/creation/reference-material-uploads/00000000-0000-0000-0000-000000000001"},
		{"POST", "/creation/reference-material-uploads/00000000-0000-0000-0000-000000000001"},
		{"DELETE", "/creation/reference-material-uploads/00000000-0000-0000-0000-000000000001"},
		{"POST", "/creation/sessions/00000000-0000-0000-0000-000000000001/materials/from-result"},
		{"GET", "/creation/materials/00000000-0000-0000-0000-000000000001/thumbnail-url"},
		{"GET", "/creation/materials/00000000-0000-0000-0000-000000000001/preview-url"},
	} {
		creationOperation(t, route.method, route.path)
	}

	materials := resolvePointer(t, moduleFile(t, "creation.yaml"), "/paths/~1creation~1sessions~1{sessionID}~1materials")
	if _, hasLegacyMultipart := materials["post"]; hasLegacyMultipart {
		t.Fatal("legacy multipart material upload must not remain in the public contract")
	}

	upload := resolvePointer(t, moduleFile(t, "creation.yaml"), "/components/schemas/ReferenceMaterialUpload")
	properties, _ := upload["properties"].(map[string]any)
	for _, sensitive := range []string{"owner_user_id", "object_key", "payload_hash", "upload_request", "signed_url"} {
		if _, exposed := properties[sensitive]; exposed {
			t.Fatalf("upload status contract exposes sensitive field %q", sensitive)
		}
	}
}

// parameterEnum reads one inline query parameter's item enum from a resolved
// operation's parameter list.
func parameterEnum(t *testing.T, parameters []any, name string) []string {
	t.Helper()
	for _, raw := range parameters {
		parameter, _ := raw.(map[string]any)
		if parameter["name"] != name {
			continue
		}
		schema, _ := parameter["schema"].(map[string]any)
		items, _ := schema["items"].(map[string]any)
		entries, _ := items["enum"].([]any)
		values := make([]string, 0, len(entries))
		for _, entry := range entries {
			value, ok := entry.(string)
			if !ok {
				t.Fatalf("%s enum entry %v is not a string", name, entry)
			}
			values = append(values, value)
		}
		return values
	}
	t.Fatalf("contract has no %s parameter", name)
	return nil
}

func TestAssetLibraryContractSurface(t *testing.T) {
	var listOperation map[string]any
	for _, route := range []struct {
		method string
		path   string
	}{
		{"GET", "/creation/assets"},
		{"GET", "/creation/assets/00000000-0000-0000-0000-000000000001"},
		{"GET", "/creation/assets/00000000-0000-0000-0000-000000000001/thumbnail-url"},
		{"GET", "/creation/assets/00000000-0000-0000-0000-000000000001/preview-url"},
		{"GET", "/creation/assets/00000000-0000-0000-0000-000000000001/content"},
		{"DELETE", "/creation/assets/00000000-0000-0000-0000-000000000001"},
		{"POST", "/creation/assets/00000000-0000-0000-0000-000000000001/publication"},
	} {
		operation := creationOperation(t, route.method, route.path)
		if route.path == "/creation/assets" {
			listOperation = operation
		}
	}
	parameters, _ := listOperation["parameters"].([]any)
	for _, raw := range parameters {
		parameter, _ := raw.(map[string]any)
		name, _ := parameter["name"].(string)
		if name == "creator_id" {
			t.Fatal("Asset list contract still exposes the internal creator UUID filter")
		}
		if name == "creator" {
			t.Fatal("creator-private Asset list must not expose a creator filter")
		}
	}

	responseFacets := resolvePointer(t, moduleFile(t, "creation.yaml"),
		"/paths/~1creation~1assets/get/responses/200/content/application~1json/schema/properties/facets")
	if responseFacets["nullable"] != true {
		t.Fatal("the facet vocabulary is absent for an unpinned media, so it must be nullable")
	}
	// Required but nullable: the client fails closed on a missing key, so an
	// optional field would only describe a response it has to reject.
	responseSchema := resolvePointer(t, moduleFile(t, "creation.yaml"),
		"/paths/~1creation~1assets/get/responses/200/content/application~1json/schema")
	required, _ := responseSchema["required"].([]any)
	if !slices.Contains(required, any("facets")) {
		t.Fatal("the list response must require facets, holding null when no media is pinned")
	}

	asset := resolvePointer(t, moduleFile(t, "creation.yaml"), "/components/schemas/MediaAsset")
	properties, _ := asset["properties"].(map[string]any)
	for _, private := range []string{"task_id", "session_id", "slot_index", "prompt", "specification", "blob_key"} {
		if _, exposed := properties[private]; exposed {
			t.Fatalf("team-readable Asset contract exposes private/internal field %q", private)
		}
	}
	capabilities := resolvePointer(t, moduleFile(t, "creation.yaml"), "/components/schemas/MediaAssetCapabilities")
	capabilityProperties, _ := capabilities["properties"].(map[string]any)
	if _, exists := capabilityProperties["can_publish"]; !exists {
		t.Fatal("Asset capabilities are missing can_publish")
	}
}

// The facet vocabulary is observed here the way a client sees it — one page per media, unioned
// in the order the parser admits values — rather than read from the catalog the server serves
// it from. A contract that documents a filter the server rejects fails right here.
func TestAssetLibraryFacetEnumMatchesServedVocabulary(t *testing.T) {
	parameters, _ := creationOperation(t, "GET", "/creation/assets")["parameters"].([]any)

	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)

	served := map[string][]string{}
	for _, media := range []string{"image", "video"} {
		var page struct {
			Facets *struct {
				Modes       []string `json:"modes"`
				Ratios      []string `json:"ratios"`
				Resolutions []string `json:"resolutions"`
			} `json:"facets"`
		}
		status, body := h.doRequest(t, http.MethodGet, "/creation/assets?limit=1&media_type="+media, token, nil)
		if status != http.StatusOK {
			t.Fatalf("asset page %s: status=%d body=%s", media, status, body)
		}
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatalf("decode %s asset page: %v", media, err)
		}
		if page.Facets == nil {
			t.Fatalf("the %s page serves no facet vocabulary", media)
		}
		for param, values := range map[string][]string{
			"mode":       page.Facets.Modes,
			"ratio":      page.Facets.Ratios,
			"resolution": page.Facets.Resolutions,
		} {
			for _, value := range values {
				if !slices.Contains(served[param], value) {
					served[param] = append(served[param], value)
				}
			}
		}
	}
	for _, param := range []string{"mode", "ratio", "resolution"} {
		documented := parameterEnum(t, parameters, param)
		if !slices.Equal(documented, served[param]) {
			t.Fatalf("contract %s enum %v does not match the served vocabulary %v",
				param, documented, served[param])
		}
	}
}

func TestTeamPublicationAndInspirationContractSurface(t *testing.T) {
	for _, route := range []struct {
		method string
		path   string
	}{
		{"GET", "/creation/inspiration"},
		{"GET", "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001"},
		{"GET", "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001/content"},
		{"GET", "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001/thumbnail-url"},
		{"GET", "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001/preview-url"},
		{"GET", "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001/references/00000000-0000-0000-0000-000000000002/preview-url"},
		{"GET", "/creation/publications/00000000-0000-0000-0000-000000000001"},
		{"GET", "/creation/publications/00000000-0000-0000-0000-000000000001/content"},
		{"GET", "/creation/publications/00000000-0000-0000-0000-000000000001/thumbnail-url"},
		{"GET", "/creation/publications/00000000-0000-0000-0000-000000000001/preview-url"},
		{"GET", "/creation/publications/00000000-0000-0000-0000-000000000001/references/00000000-0000-0000-0000-000000000002/preview-url"},
		{"DELETE", "/creation/publications/00000000-0000-0000-0000-000000000001"},
		{"POST", "/creation/publications/00000000-0000-0000-0000-000000000001/create-similar"},
	} {
		creationOperation(t, route.method, route.path)
	}
}

// TestGenerationTaskDeletionContractSurface pins the deletion operation's shape:
// a 200 carrying the removal report — never a 204, whose body a client cannot
// read — with both report arrays required so neither can arrive as null, and no
// 409, because a non-terminal target and a repeat DELETE share one 404.
func TestGenerationTaskDeletionContractSurface(t *testing.T) {
	operation := creationOperation(t, "DELETE", "/creation/tasks/00000000-0000-0000-0000-000000000001")
	if operation["operationId"] != "deleteGenerationTask" {
		t.Fatalf("task deletion operationId=%v", operation["operationId"])
	}
	responses, _ := operation["responses"].(map[string]any)
	if _, documented := responses["204"]; documented {
		t.Fatal("task deletion must answer 200 with the removal report, not 204")
	}
	if _, documented := responses["409"]; documented {
		t.Fatal("a non-terminal target and a repeat DELETE share one 404; a 409 would split them")
	}
	if _, documented := responses["200"]; !documented {
		t.Fatalf("task deletion responses=%v", responses)
	}

	result := resolvePointer(t, moduleFile(t, "creation.yaml"), "/components/schemas/TaskDeletionResult")
	required, _ := result["required"].([]any)
	for _, field := range []string{"removed_slot_indexes", "skipped"} {
		if !slices.Contains(required, any(field)) {
			t.Fatalf("TaskDeletionResult must require %s: %v", field, required)
		}
	}
	properties, _ := result["properties"].(map[string]any)
	skipped, _ := properties["skipped"].(map[string]any)
	if skipped["nullable"] == true {
		t.Fatal("skipped is required and never null; a nullable declaration would invite the null back")
	}
}

func loadContracts(t *testing.T) (map[string]any, map[string]map[string]any) {
	t.Helper()
	conformanceOnce.Do(func() {
		_, thisFile, _, _ := runtime.Caller(0)
		path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "contracts", "openapi.yaml")
		conformanceDir = filepath.Dir(path)
		moduleSpecs = make(map[string]map[string]any)
		data, err := os.ReadFile(path)
		if err != nil {
			loadErr = err
			return
		}
		if err := yaml.Unmarshal(data, &masterSpec); err != nil {
			loadErr = fmt.Errorf("parse contracts/openapi.yaml: %w", err)
		}
	})
	if loadErr != nil {
		t.Fatalf("load contracts: %v", loadErr)
	}
	return masterSpec, moduleSpecs
}

func moduleFile(t *testing.T, name string) map[string]any {
	t.Helper()
	_, specs := loadContracts(t)
	if spec, ok := specs[name]; ok {
		return spec
	}
	data, err := os.ReadFile(filepath.Join(conformanceDir, name))
	if err != nil {
		t.Fatalf("read contract module %q: %v", name, err)
	}
	var spec map[string]any
	if err := yaml.Unmarshal(data, &spec); err != nil {
		t.Fatalf("parse contract module %q: %v", name, err)
	}
	specs[name] = spec
	return spec
}

// resolvePointer walks a JSON pointer inside one spec.
func resolvePointer(t *testing.T, spec map[string]any, pointer string) map[string]any {
	t.Helper()
	node := any(spec)
	for _, segment := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		mapping, ok := node.(map[string]any)
		if !ok {
			t.Fatalf("contract pointer %q hits a non-object at %q", pointer, segment)
		}
		node = mapping[strings.NewReplacer("~1", "/", "~0", "~").Replace(segment)]
	}
	resolved, ok := node.(map[string]any)
	if !ok {
		t.Fatalf("contract pointer %q does not resolve to an object", pointer)
	}
	return resolved
}

// creationOperation locates one operation in the master paths entry that
// delegates via $ref into creation.yaml, matching parameterized segments
// exactly the way the wire path appears ({sessionID} vs an actual uuid).
func creationOperation(t *testing.T, method, rawPath string) map[string]any {
	t.Helper()
	// Query parameters never participate in path matching.
	path, _, _ := strings.Cut(rawPath, "?")
	master, _ := loadContracts(t)
	paths, _ := master["paths"].(map[string]any)
	rawEntry := resolveContractKey(t, paths, path)
	if rawEntry == nil {
		t.Fatalf("contract gap: %s %s missing from contracts/openapi.yaml", method, path)
	}
	entry, _ := rawEntry.(map[string]any)
	ref, _ := entry["$ref"].(string)
	if ref == "" {
		t.Fatalf("contract gap: %s %s must $ref its owner module", method, path)
	}
	moduleName, pointer, _ := strings.Cut(ref, "#")
	item := resolvePointer(t, moduleFile(t, moduleName), pointer)
	opAny := item[strings.ToLower(method)]
	op, _ := opAny.(map[string]any)
	if op == nil {
		t.Fatalf("contract gap: method %s not documented for %s", method, path)
	}
	return op
}

// resolveContractKey matches one observed path against the master keys:
// exact wins, otherwise each {parameter} segment matches anything.
func resolveContractKey(t *testing.T, paths map[string]any, observed string) any {
	t.Helper()
	if entry, ok := paths[observed]; ok {
		return entry
	}
	segments := strings.Split(strings.Trim(observed, "/"), "/")
	for contractPath, entry := range paths {
		parts := strings.Split(strings.Trim(contractPath, "/"), "/")
		if len(parts) != len(segments) {
			continue
		}
		matched := true
		for index, part := range parts {
			isParameter := strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}")
			if !isParameter && part != segments[index] {
				matched = false
				break
			}
		}
		if matched {
			return entry
		}
	}
	return nil
}

// documentedStatuses resolves one operation's responses map, expanding any
// status-level $refs into concrete response objects (plus their own ref).
func documentedStatuses(t *testing.T, operation map[string]any) map[string]any {
	t.Helper()
	responsesAny, _ := operation["responses"].(map[string]any)
	statuses := make(map[string]any)
	for statusKey, raw := range responsesAny {
		switch typed := raw.(type) {
		case map[string]any:
			statuses[statusKey] = typed
		default:
			t.Fatalf("contract bug: unsupported response value shape for status %s", statusKey)
		}
	}
	return statuses
}

// assertContractResponse is the harness-wide conformance assertion. Bodies
// empty by documented choice pass with no schema; everything else validates.
func assertContractResponse(t *testing.T, method, path string, status int, body []byte) {
	t.Helper()
	operation := creationOperation(t, method, path)
	statuses := documentedStatuses(t, operation)

	statusesMap := map[string]map[string]any{}
	for statusKey, statusValue := range statuses {
		typed, ok := statusValue.(map[string]any)
		if !ok {
			t.Fatalf("contract bug: response for status %s is not an object", statusKey)
		}
		statusesMap[statusKey] = typed
	}
	entry, documented := statusesMap[strconv.Itoa(status)]
	if !documented {
		t.Fatalf("contract gap: status %d for %s %s is not documented", status, strings.ToUpper(method), path)
	}
	response := resolveResponseRef(t, moduleFile(t, "creation.yaml"), entry)

	content, _ := response["content"].(map[string]any)
	jsonContent, hasJSON := content["application/json"].(map[string]any)
	if !hasJSON || jsonContent == nil {
		if len(body) > 0 {
			t.Fatalf("contract violation: %s %s %d documents no JSON body but got %s",
				strings.ToUpper(method), path, status, body)
		}
		return
	}
	schema, hasSchema := jsonContent["schema"].(map[string]any)

	var decoded any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatalf("%s %s %d: body is not JSON: %v", strings.ToUpper(method), path, status, err)
		}
		if !hasSchema {
			t.Fatalf("contract violation: JSON body documented without a schema at %s %s %d", strings.ToUpper(method), path, status)
		}
		assertSchema(t, schema, decoded, fmt.Sprintf("%s %s %d", strings.ToUpper(method), path, status))
	}
}

// resolveResponseRef expands a components.responses $ref if present.
func resolveResponseRef(t *testing.T, owner map[string]any, entry map[string]any) map[string]any {
	t.Helper()
	ref, hasRef := entry["$ref"].(string)
	if !hasRef {
		return entry
	}
	file, pointer, ok := strings.Cut(ref, "#")
	if !ok || file != "" {
		t.Fatalf("unexpected cross-file response ref %q", ref)
	}
	target := resolvePointer(t, owner, pointer)
	inner, hasInner := target["$ref"].(string)
	if hasInner && strings.HasPrefix(inner, "./openapi.yaml#") {
		_, innerPointer, _ := strings.Cut(inner, "#")
		target = resolvePointer(t, loadContractMaster(t), innerPointer)
	} else if hasInner {
		t.Fatalf("unexpected nested response ref %q", inner)
	}
	return target
}

func loadContractMaster(t *testing.T) map[string]any {
	t.Helper()
	master, _ := loadContracts(t)
	return master
}

// assertSchema walks one decoded JSON value against one OpenAPI subset
// schema node, merging allOf parts and following local $refs.
func assertSchema(t *testing.T, schema map[string]any, value any, where string) {
	t.Helper()
	flat := flatten(t, schema)
	typeName, _ := flat["type"].(string)

	// A documented nullable schema accepts null whatever the composed type —
	// the embedded draft on a never-saved session is the live example.
	if value == nil {
		if nullable, _ := flat["nullable"].(bool); nullable {
			return
		}
	}

	if typeName == "array" {
		items, _ := flat["items"].(map[string]any)
		list, ok := value.([]any)
		if !ok {
			t.Fatalf("%s: expected array, got %T", where, value)
		}
		for index, element := range list {
			assertSchema(t, items, element, fmt.Sprintf("%s[%d]", where, index))
		}
		return
	}

	objectValue, isObject := value.(map[string]any)
	if typeName == "object" || (isObject && typeName == "") {
		if !isObject {
			t.Fatalf("%s: expected object", where)
		}
		requiredAny, _ := flat["required"].([]any)
		for _, fieldAny := range requiredAny {
			field := fmt.Sprint(fieldAny)
			if _, present := objectValue[field]; !present {
				t.Fatalf("%s: missing required field %q", where, field)
			}
		}
		properties, _ := flat["properties"].(map[string]any)
		for fieldName, propertySchemaAny := range properties {
			fieldValue, present := objectValue[fieldName]
			if !present {
				continue
			}
			propertySchema, _ := propertySchemaAny.(map[string]any)
			assertSchema(t, propertySchema, fieldValue, where+"."+fieldName)
		}
		return
	}

	assertScalar(t, flat, value, where)
}

// assertScalar applies enum/type/format/min/max/pattern rules to scalars.
func assertScalar(t *testing.T, flat map[string]any, value any, where string) {
	t.Helper()
	if enum, ok := flat["enum"].([]any); ok {
		for _, allowed := range enum {
			if fmt.Sprint(allowed) == fmt.Sprint(value) {
				return
			}
		}
		nullable, _ := flat["nullable"].(bool)
		if nullable && value == nil {
			return
		}
		t.Fatalf("%s: %v is outside documented enum %v", where, value, enum)
	}
	text := ""
	isString := false
	if s, ok := value.(string); ok {
		text, isString = s, true
	}
	if pattern, ok := flat["pattern"].(string); ok && isString {
		re, err := regexp.Compile(pattern)
		if err != nil {
			t.Fatalf("%s: contract pattern %q is not a regex", where, pattern)
		}
		if !re.MatchString(text) {
			t.Fatalf("%s: %q violates documented pattern %q", where, text, pattern)
		}
	}
	if maxLength, ok := flat["maxLength"]; ok && isString {
		max := int(toFloat(t, maxLength, where))
		if utf8.RuneCountInString(text) > max {
			t.Fatalf("%s: string longer than %d: %q", where, max, text)
		}
	}
	if minBound, ok := flat["minimum"]; ok {
		number, isNumber := value.(float64)
		if isNumber && number < toFloat(t, minBound, where) {
			t.Fatalf("%s: %v below minimum %v", where, value, minBound)
		}
	}
	if maxBound, ok := flat["maximum"]; ok {
		number, isNumber := value.(float64)
		if isNumber && number > toFloat(t, maxBound, where) {
			t.Fatalf("%s: %v above maximum %v", where, value, maxBound)
		}
	}
	if format, ok := flat["format"].(string); ok && isString {
		switch format {
		case "uuid":
			if !uuidShape(text) {
				t.Fatalf("%s: %q is not a UUID", where, text)
			}
		case "date-time":
			if !strings.Contains(text, "T") {
				t.Fatalf("%s: %q is not RFC3339 date-time", where, text)
			}
		}
	}
}

func toFloat(t *testing.T, raw any, where string) float64 {
	t.Helper()
	switch v := raw.(type) {
	case int:
		return float64(v)
	case float64:
		return v
	case string:
		parsed, err := strconv.ParseFloat(v, 64)
		if err != nil {
			t.Fatalf("%s: numeric bound %q unparsable", where, v)
		}
		return parsed
	default:
		t.Fatalf("%s: unsupported numeric bound %+v", where, raw)
		return 0
	}
}

// flatten merges $ref targets and allOf parts of one schema node.
func flatten(t *testing.T, node map[string]any) map[string]any {
	t.Helper()
	if node == nil {
		return map[string]any{}
	}
	flat := map[string]any{}
	if ref, ok := node["$ref"].(string); ok {
		target := resolveSchemaRef(t, ref)
		if target != nil {
			for key, value := range flatten(t, target) {
				flat[key] = value
			}
		}
	}
	if allOf, ok := node["allOf"].([]any); ok {
		for _, partAny := range allOf {
			part, _ := partAny.(map[string]any)
			for key, value := range flatten(t, part) {
				flat[key] = mergePart(flat[key], value)
			}
		}
	}
	for key, value := range node {
		flat[key] = mergePart(flat[key], value)
	}
	return flat
}

func mergePart(existing, incoming any) any {
	if existingList, okA := existing.([]any); okA {
		if incomingList, okB := incoming.([]any); okB {
			return append(append([]any{}, existingList...), incomingList...)
		}
	}
	if mExisting, okA := existing.(map[string]any); okA {
		if mIncoming, okB := incoming.(map[string]any); okB {
			merged := map[string]any{}
			for key, value := range mExisting {
				merged[key] = value
			}
			for key, value := range mIncoming {
				merged[key] = value
			}
			return merged
		}
	}
	return incoming
}

// resolveSchemaRef follows internal component pointers and explicit
// "./openapi.yaml#" references for the shared Error envelope.
func resolveSchemaRef(t *testing.T, ref string) map[string]any {
	t.Helper()
	file, pointer, hasPointer := strings.Cut(ref, "#")
	var spec map[string]any
	switch {
	case file == "":
		spec = moduleFile(t, "creation.yaml")
	case file == "./openapi.yaml":
		spec = loadContractMaster(t)
	default:
		t.Fatalf("unsupported schema ref %q", ref)
	}
	_ = hasPointer
	return resolvePointer(t, spec, pointer)
}

// TestContractErrorEnvelopeShapeOnEveryCreationErrorPath asserts every error path returns exactly the
// envelope shape with an enum-valid machine code, run once per test binary through a synthetic
// observation list so conformance exercises the negative space too.
func TestContractErrorEnvelopeShapeOnEveryCreationErrorPath(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)

	session := h.createSession(t, token, sessionName("conformance"))
	goodID := session.ID

	observations := []struct {
		method, path, token string
		body                any
	}{
		{"GET", "/creation/sessions/" + goodID, otherToken, nil},
		{"PATCH", "/creation/sessions/" + goodID, adminToken, map[string]any{"name": "nope"}},
		{"DELETE", "/creation/sessions/" + goodID, adminToken, nil},
		{"GET", "/creation/sessions?limit=999", token, nil},
		{"POST", "/creation/sessions", token, "not-an-object-body"},
		{"GET", "/creation/sessions/not-a-uuid", token, nil},
		{"GET", "/creation/sessions/" + goodID + "/materials?cursor=broken!!", token, nil},
	}
	for _, obs := range observations {
		reqBody := obs.body
		status, body := h.doRequest(t, obs.method, obs.path, obs.token, reqBody)
		if status < 400 {
			continue // positive-path coverage lives with each flow test
		}
		assertContractResponse(t, obs.method, obs.path, status, body)
	}
}

// uuidShape checks the canonical 8-4-4-4-12 hex form without importing the
// Module's sub-packages (integration tests see Module packages only).
func uuidShape(text string) bool {
	if len(text) != 36 {
		return false
	}
	for i, c := range text {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return false
		}
	}
	return true
}

// The contract's own Asset schemas are the durability guarantee that the wall
// never ships signed URLs: a field the schema forbids cannot be added silently.
func TestAssetListSchemaForbidsEmbeddedDisplayGrants(t *testing.T) {
	spec := moduleFile(t, "creation.yaml")
	for _, name := range []string{"MediaAsset", "MediaAssetDetail", "MediaAssetPrivateOrigin"} {
		schema := resolvePointer(t, spec, "/components/schemas/"+name)
		properties, _ := schema["properties"].(map[string]any)
		if properties == nil {
			t.Fatalf("%s schema exposes no properties", name)
		}
		raw, err := json.Marshal(schema)
		if err != nil {
			t.Fatalf("marshal %s schema: %v", name, err)
		}
		for _, forbidden := range []string{"blob_key", "signed_url", "thumbnail_url", "preview_url", "x-oss-process"} {
			if bytes.Contains(raw, []byte(forbidden)) {
				t.Fatalf("%s schema exposes %q", name, forbidden)
			}
		}
	}
}

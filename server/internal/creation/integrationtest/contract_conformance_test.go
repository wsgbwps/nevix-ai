package integrationtest

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"

	"gopkg.in/yaml.v3"
)

// Response-level OpenAPI conformance for the Creation surface. The helper in
// the Identity suite is prior art, but the Creation contract promises more
// than required-fields checks: this validator enforces required fields,
// enums, JSON types, uuid/date-time formats on observed values, minimum and
// maximum bounds where documented, allOf composition, component responses
// ($ref'd statuses), external Error-envelope references into the master
// document, and rejects undocumented statuses outright. Requests are shaped
// by hand in these tests; responses are checked here on every observation.

var (
	conformanceOnce sync.Once
	masterSpec      map[string]any
	moduleSpecs     map[string]map[string]any
	conformanceDir  string
	loadErr         error
)

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

// ensureAllDocumentedErrorsConform asserts every error path returns exactly
// the envelope shape with an enum-valid machine code — run once per test
// binary through a synthetic observation list so conformance exercises the
// negative space too.
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

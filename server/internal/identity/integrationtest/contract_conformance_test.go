// Response-level contract conformance: every observed HTTP response in the
// integration suite is asserted against contracts/openapi.yaml — the status
// must have a documented entry, the body must carry the documented required
// fields, and an error machine code must belong to the documented enum for
// that status. This is the drift defense the contract header promises now
// that more than one trusted command exists.
package integrationtest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"

	"gopkg.in/yaml.v3"
)

var (
	contractOnce    sync.Once
	contractSpec    map[string]any
	contractDir     string
	contractModules map[string]map[string]any
	contractLoadErr error
)

// loadContractSpec reads contracts/openapi.yaml once per test run.
func loadContractSpec(t *testing.T) map[string]any {
	t.Helper()
	contractOnce.Do(func() {
		_, thisFile, _, _ := runtime.Caller(0)
		path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "contracts", "openapi.yaml")
		contractDir = filepath.Dir(path)
		contractModules = make(map[string]map[string]any)
		data, err := os.ReadFile(path)
		if err != nil {
			contractLoadErr = err
			return
		}
		if err := yaml.Unmarshal(data, &contractSpec); err != nil {
			contractLoadErr = fmt.Errorf("parse contracts/openapi.yaml: %w", err)
		}
	})
	if contractLoadErr != nil {
		t.Fatalf("load contract: %v", contractLoadErr)
	}
	return contractSpec
}

// assertContractResponse asserts one observed response against the contract.
func assertContractResponse(t *testing.T, method, path string, status int, body []byte) {
	t.Helper()
	spec := loadContractSpec(t)

	paths, _ := spec["paths"].(map[string]any)
	entry := contractPathEntry(t, paths, path)
	operation, _ := entry[strings.ToLower(method)].(map[string]any)
	if operation == nil {
		t.Fatalf("contract gap: %s %s has no entry in contracts/openapi.yaml", strings.ToUpper(method), path)
	}
	responses, _ := operation["responses"].(map[string]any)
	response, _ := responses[strconv.Itoa(status)].(map[string]any)
	if response == nil {
		t.Fatalf("contract gap: status %d for %s %s is not documented", status, strings.ToUpper(method), path)
	}
	content, _ := response["content"].(map[string]any)
	jsonContent, _ := content["application/json"].(map[string]any)
	if jsonContent == nil {
		if len(body) > 0 {
			t.Fatalf("contract gap: status %d for %s %s documents no JSON body, got %s", status, strings.ToUpper(method), path, body)
		}
		return
	}
	schema, _ := jsonContent["schema"].(map[string]any)

	var decoded map[string]any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatalf("%s %s status %d: body is not JSON: %v", strings.ToUpper(method), path, status, err)
		}
	}
	assertMatchesSchema(t, spec, schema, decoded, fmt.Sprintf("%s %s %d", strings.ToUpper(method), path, status))
}

// contractPathEntry resolves an observed path to its OpenAPI Path Item. Exact
// paths win; parameter segments then match exactly one path segment. A master
// contract may delegate the item to its owning module through an external $ref.
func contractPathEntry(t *testing.T, paths map[string]any, observedPath string) map[string]any {
	t.Helper()
	if exact, _ := paths[observedPath].(map[string]any); exact != nil {
		return resolveContractPathItem(t, exact)
	}
	observed := strings.Split(strings.Trim(observedPath, "/"), "/")
	for contractPath, rawEntry := range paths {
		contract := strings.Split(strings.Trim(contractPath, "/"), "/")
		if len(contract) != len(observed) {
			continue
		}
		matches := true
		for index, segment := range contract {
			isParameter := strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}")
			if !isParameter && segment != observed[index] {
				matches = false
				break
			}
		}
		if matches {
			entry, _ := rawEntry.(map[string]any)
			return resolveContractPathItem(t, entry)
		}
	}
	return nil
}

func resolveContractPathItem(t *testing.T, entry map[string]any) map[string]any {
	t.Helper()
	ref, ok := entry["$ref"].(string)
	if !ok {
		return entry
	}
	module, pointer, ok := strings.Cut(ref, "#")
	if !ok || module == "" || pointer == "" {
		t.Fatalf("contract path reference %q must name a module and JSON pointer", ref)
	}
	spec := loadContractModule(t, module)
	node := any(spec)
	for _, segment := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		mapping, ok := node.(map[string]any)
		if !ok {
			t.Fatalf("contract path reference %q has a non-object segment before %q", ref, segment)
		}
		node = mapping[strings.NewReplacer("~1", "/", "~0", "~").Replace(segment)]
	}
	resolved, ok := node.(map[string]any)
	if !ok {
		t.Fatalf("contract path reference %q does not resolve to an object", ref)
	}
	return resolved
}

func loadContractModule(t *testing.T, module string) map[string]any {
	t.Helper()
	if spec := contractModules[module]; spec != nil {
		return spec
	}
	data, err := os.ReadFile(filepath.Join(contractDir, module))
	if err != nil {
		t.Fatalf("read contract module %q: %v", module, err)
	}
	var spec map[string]any
	if err := yaml.Unmarshal(data, &spec); err != nil {
		t.Fatalf("parse contract module %q: %v", module, err)
	}
	contractModules[module] = spec
	return spec
}

// assertMatchesSchema checks one decoded body against one flattened schema:
// required fields exist, enum-constrained properties hold a documented value,
// and nested objects are checked recursively.
func assertMatchesSchema(t *testing.T, spec, schema, value map[string]any, where string) {
	t.Helper()
	flat := flattenSchema(spec, schema, map[string]bool{})

	for _, required := range flat["required"].([]any) {
		name := fmt.Sprint(required)
		if _, ok := value[name]; !ok {
			t.Fatalf("contract violation at %s: response is missing required field %q", where, name)
		}
	}
	properties, _ := flat["properties"].(map[string]any)
	for name, propertyNode := range properties {
		propertyValue, exists := value[name]
		if !exists {
			continue
		}
		propertySchema, _ := propertyNode.(map[string]any)
		propertyFlat := flattenSchema(spec, propertySchema, map[string]bool{})
		if enum, ok := propertyFlat["enum"].([]any); ok {
			matched := false
			for _, allowed := range enum {
				if fmt.Sprint(allowed) == fmt.Sprint(propertyValue) {
					matched = true
					break
				}
			}
			if !matched {
				t.Fatalf("contract violation at %s: field %q is %v, not among documented enum %v", where, name, propertyValue, enum)
			}
		}
		if nested, ok := propertyValue.(map[string]any); ok && len(propertyFlat["properties"].(map[string]any)) > 0 {
			assertMatchesSchema(t, spec, propertySchema, nested, where+"."+name)
		}
	}
}

// flattenSchema merges $ref targets, allOf parts, and the node's own keys into
// one object schema with accumulated "required" and "properties".
func flattenSchema(spec map[string]any, node map[string]any, visited map[string]bool) map[string]any {
	flat := map[string]any{"required": []any{}, "properties": map[string]any{}}
	if node == nil {
		return flat
	}
	if ref, ok := node["$ref"].(string); ok && !visited[ref] {
		if target := resolveRef(spec, ref); target != nil {
			visited[ref] = true
			mergeSchema(flat, flattenSchema(spec, target, visited))
		}
	}
	if allOf, ok := node["allOf"].([]any); ok {
		for _, part := range allOf {
			if partSchema, ok := part.(map[string]any); ok {
				mergeSchema(flat, flattenSchema(spec, partSchema, visited))
			}
		}
	}
	mergeSchema(flat, node)
	return flat
}

// mergeSchema folds one schema node's required list, properties, and enum
// into the accumulator.
func mergeSchema(flat, node map[string]any) {
	if required, ok := node["required"].([]any); ok {
		flat["required"] = append(flat["required"].([]any), required...)
	}
	if properties, ok := node["properties"].(map[string]any); ok {
		merged := flat["properties"].(map[string]any)
		for name, property := range properties {
			merged[name] = property
		}
	}
	if enum, ok := node["enum"]; ok {
		flat["enum"] = enum
	}
}

// resolveRef follows an internal "#/components/..." pointer.
func resolveRef(spec map[string]any, ref string) map[string]any {
	node := any(spec)
	for _, segment := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[segment]
	}
	resolved, _ := node.(map[string]any)
	return resolved
}

package domain

// ImageSize is one vendor pixel resolution ("宽x高") for a single
// (model, ratio, resolution tier) combination.
type ImageSize struct {
	Width  int
	Height int
}

// imageSizeKey is one accepted (model, ratio, resolution) combination. The
// frozen specification's manifest-validated cross product is the key set.
type imageSizeKey struct {
	model      string
	ratio      string
	resolution string
}

// imageSizes pins the Kapon wire pixel size for every (model, ratio, resolution) pair,
// transcribed from the vendor 豆包生图 OpenAPI x-size-map. The table is per model — pro
// publishes 1K/1.5K/2K and base 2K/3K/4K, and an overlapping tier label resolves to
// different pixels (2K at 16:9 is 2816x1584 on pro but 2848x1600 on base) — so the key
// never drops the model. The manifest publishes the same table as display sizes.
var imageSizes = map[imageSizeKey]ImageSize{
	// doubao-seedream-5.0-pro
	{ImageModelID, "1:1", "1K"}:    {1024, 1024},
	{ImageModelID, "1:1", "1.5K"}:  {1536, 1536},
	{ImageModelID, "1:1", "2K"}:    {2048, 2048},
	{ImageModelID, "4:3", "1K"}:    {1152, 864},
	{ImageModelID, "4:3", "1.5K"}:  {1792, 1344},
	{ImageModelID, "4:3", "2K"}:    {2368, 1776},
	{ImageModelID, "3:4", "1K"}:    {864, 1152},
	{ImageModelID, "3:4", "1.5K"}:  {1344, 1792},
	{ImageModelID, "3:4", "2K"}:    {1776, 2368},
	{ImageModelID, "16:9", "1K"}:   {1424, 800},
	{ImageModelID, "16:9", "1.5K"}: {2048, 1152},
	{ImageModelID, "16:9", "2K"}:   {2816, 1584},
	{ImageModelID, "9:16", "1K"}:   {800, 1424},
	{ImageModelID, "9:16", "1.5K"}: {1152, 2048},
	{ImageModelID, "9:16", "2K"}:   {1584, 2816},
	{ImageModelID, "3:2", "1K"}:    {1248, 832},
	{ImageModelID, "3:2", "1.5K"}:  {1872, 1248},
	{ImageModelID, "3:2", "2K"}:    {2496, 1664},
	{ImageModelID, "2:3", "1K"}:    {832, 1248},
	{ImageModelID, "2:3", "1.5K"}:  {1248, 1872},
	{ImageModelID, "2:3", "2K"}:    {1664, 2496},
	{ImageModelID, "21:9", "1K"}:   {1568, 672},
	{ImageModelID, "21:9", "1.5K"}: {2352, 1008},
	{ImageModelID, "21:9", "2K"}:   {3136, 1344},

	// doubao-seedream-5.0 (base)
	{ImageModelBaseID, "1:1", "2K"}:  {2048, 2048},
	{ImageModelBaseID, "1:1", "3K"}:  {3072, 3072},
	{ImageModelBaseID, "1:1", "4K"}:  {4096, 4096},
	{ImageModelBaseID, "4:3", "2K"}:  {2304, 1728},
	{ImageModelBaseID, "4:3", "3K"}:  {3456, 2592},
	{ImageModelBaseID, "4:3", "4K"}:  {4704, 3520},
	{ImageModelBaseID, "3:4", "2K"}:  {1728, 2304},
	{ImageModelBaseID, "3:4", "3K"}:  {2592, 3456},
	{ImageModelBaseID, "3:4", "4K"}:  {3520, 4704},
	{ImageModelBaseID, "16:9", "2K"}: {2848, 1600},
	{ImageModelBaseID, "16:9", "3K"}: {4096, 2304},
	{ImageModelBaseID, "16:9", "4K"}: {5504, 3040},
	{ImageModelBaseID, "9:16", "2K"}: {1600, 2848},
	{ImageModelBaseID, "9:16", "3K"}: {2304, 4096},
	{ImageModelBaseID, "9:16", "4K"}: {3040, 5504},
	{ImageModelBaseID, "3:2", "2K"}:  {2496, 1664},
	{ImageModelBaseID, "3:2", "3K"}:  {3744, 2496},
	{ImageModelBaseID, "3:2", "4K"}:  {4992, 3328},
	{ImageModelBaseID, "2:3", "2K"}:  {1664, 2496},
	{ImageModelBaseID, "2:3", "3K"}:  {2496, 3744},
	{ImageModelBaseID, "2:3", "4K"}:  {3328, 4992},
	{ImageModelBaseID, "21:9", "2K"}: {3136, 1344},
	{ImageModelBaseID, "21:9", "3K"}: {4704, 2016},
	{ImageModelBaseID, "21:9", "4K"}: {6240, 2656},

	// gemini-3.1-flash-image (Apifox Gemini image dimensions)
	{GeminiModelID, "1:1", "512"}:  {512, 512},
	{GeminiModelID, "1:1", "1K"}:   {1024, 1024},
	{GeminiModelID, "1:1", "2K"}:   {2048, 2048},
	{GeminiModelID, "1:1", "4K"}:   {4096, 4096},
	{GeminiModelID, "1:4", "512"}:  {256, 1024},
	{GeminiModelID, "1:4", "1K"}:   {512, 2048},
	{GeminiModelID, "1:4", "2K"}:   {1024, 4096},
	{GeminiModelID, "1:4", "4K"}:   {2048, 8192},
	{GeminiModelID, "1:8", "512"}:  {192, 1536},
	{GeminiModelID, "1:8", "1K"}:   {384, 3072},
	{GeminiModelID, "1:8", "2K"}:   {768, 6144},
	{GeminiModelID, "1:8", "4K"}:   {1536, 12288},
	{GeminiModelID, "2:3", "512"}:  {424, 632},
	{GeminiModelID, "2:3", "1K"}:   {848, 1264},
	{GeminiModelID, "2:3", "2K"}:   {1696, 2528},
	{GeminiModelID, "2:3", "4K"}:   {3392, 5056},
	{GeminiModelID, "3:2", "512"}:  {632, 424},
	{GeminiModelID, "3:2", "1K"}:   {1264, 848},
	{GeminiModelID, "3:2", "2K"}:   {2528, 1696},
	{GeminiModelID, "3:2", "4K"}:   {5056, 3392},
	{GeminiModelID, "3:4", "512"}:  {448, 600},
	{GeminiModelID, "3:4", "1K"}:   {896, 1200},
	{GeminiModelID, "3:4", "2K"}:   {1792, 2400},
	{GeminiModelID, "3:4", "4K"}:   {3584, 4800},
	{GeminiModelID, "4:1", "512"}:  {1024, 256},
	{GeminiModelID, "4:1", "1K"}:   {2048, 512},
	{GeminiModelID, "4:1", "2K"}:   {4096, 1024},
	{GeminiModelID, "4:1", "4K"}:   {8192, 2048},
	{GeminiModelID, "4:3", "512"}:  {600, 448},
	{GeminiModelID, "4:3", "1K"}:   {1200, 896},
	{GeminiModelID, "4:3", "2K"}:   {2400, 1792},
	{GeminiModelID, "4:3", "4K"}:   {4800, 3584},
	{GeminiModelID, "4:5", "512"}:  {464, 576},
	{GeminiModelID, "4:5", "1K"}:   {928, 1152},
	{GeminiModelID, "4:5", "2K"}:   {1856, 2304},
	{GeminiModelID, "4:5", "4K"}:   {3712, 4608},
	{GeminiModelID, "5:4", "512"}:  {576, 464},
	{GeminiModelID, "5:4", "1K"}:   {1152, 928},
	{GeminiModelID, "5:4", "2K"}:   {2304, 1856},
	{GeminiModelID, "5:4", "4K"}:   {4608, 3712},
	{GeminiModelID, "8:1", "512"}:  {1536, 192},
	{GeminiModelID, "8:1", "1K"}:   {3072, 384},
	{GeminiModelID, "8:1", "2K"}:   {6144, 768},
	{GeminiModelID, "8:1", "4K"}:   {12288, 1536},
	{GeminiModelID, "9:16", "512"}: {384, 688},
	{GeminiModelID, "9:16", "1K"}:  {768, 1376},
	{GeminiModelID, "9:16", "2K"}:  {1536, 2752},
	{GeminiModelID, "9:16", "4K"}:  {3072, 5504},
	{GeminiModelID, "16:9", "512"}: {688, 384},
	{GeminiModelID, "16:9", "1K"}:  {1376, 768},
	{GeminiModelID, "16:9", "2K"}:  {2752, 1536},
	{GeminiModelID, "16:9", "4K"}:  {5504, 3072},
	{GeminiModelID, "21:9", "512"}: {792, 168},
	{GeminiModelID, "21:9", "1K"}:  {1584, 672},
	{GeminiModelID, "21:9", "2K"}:  {3168, 1344},
	{GeminiModelID, "21:9", "4K"}:  {6336, 2688},
}

// ImageSizeFor resolves one accepted (model, ratio, resolution) triple onto the vendor
// pixel size. A missing combination is an internal contract violation at the call sites,
// never a silent downgrade — the completeness invariant is pinned by the domain tests.
func ImageSizeFor(model, ratio, resolution string) (ImageSize, bool) {
	size, ok := imageSizes[imageSizeKey{model: model, ratio: ratio, resolution: resolution}]
	return size, ok
}

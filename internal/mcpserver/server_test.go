package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/soggycactus/paprika-3-mcp/internal/paprika"
)

type fakeAPI struct {
	recipes map[string]*paprika.Recipe
	saved   []paprika.Recipe
	gets    int
}

func (f *fakeAPI) ListRecipes(ctx context.Context) (*paprika.RecipeList, error) {
	l := &paprika.RecipeList{}
	for uid, r := range f.recipes {
		l.Result = append(l.Result, struct {
			UID  string `json:"uid"`
			Hash string `json:"hash"`
		}{uid, r.Hash})
	}
	return l, nil
}

func (f *fakeAPI) GetRecipe(ctx context.Context, uid string) (*paprika.Recipe, error) {
	f.gets++
	r := *f.recipes[uid]
	return &r, nil
}

func (f *fakeAPI) SaveRecipe(ctx context.Context, r paprika.Recipe) (*paprika.Recipe, error) {
	f.saved = append(f.saved, r)
	if r.UID == "" {
		r.UID = "NEW"
	}
	f.recipes[r.UID] = &r
	return &r, nil
}

func call(args map[string]interface{}) mcp.CallToolRequest {
	var req mcp.CallToolRequest
	req.Params.Arguments = args
	return req
}

func text(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	b, _ := json.Marshal(res.Content)
	return string(b)
}

func newFake() *fakeAPI {
	var withExtra paprika.Recipe
	_ = json.Unmarshal([]byte(`{"uid":"DAL","name":"Masoor dal","ingredients":"red lentils\npotato","notes":"Yukon Gold for sweet potato","rating":4,"categories":["CAT1"],"photo":"dal.jpg","source":"NYT Cooking","photos":[{"n":1}],"hash":"h1","created":"2026-11-08 18:00:00"}`), &withExtra)
	return &fakeAPI{recipes: map[string]*paprika.Recipe{
		"DAL":   &withExtra,
		"SOUP":  {UID: "SOUP", Name: "Spicy coconut chicken noodle soup", Ingredients: "chicken\nrice ramen", Source: "America's Test Kitchen", Hash: "h2"},
		"TRASH": {UID: "TRASH", Name: "Old lentil thing", Ingredients: "lentils", InTrash: true, Hash: "h3"},
	}}
}

func TestUpdateOnlyChangesGivenFields(t *testing.T) {
	f := newFake()
	s := newServer(f, "test", nil)
	res, _ := s.updateRecipe(context.Background(), call(map[string]interface{}{
		"uid":          "DAL",
		"append_notes": "Tiffani: coconut milk in her bowl only.",
	}))
	if res.IsError {
		t.Fatalf("update failed: %s", text(t, res))
	}
	got := f.saved[0]
	if got.Rating != 4 || got.Photo != "dal.jpg" || len(got.Categories) != 1 || got.Source != "NYT Cooking" || got.Ingredients != "red lentils\npotato" {
		t.Fatalf("untouched fields changed: %+v", got)
	}
	if got.Created != "2026-11-08 18:00:00" {
		t.Fatalf("created changed: %s", got.Created)
	}
	if got.Notes != "Yukon Gold for sweet potato\n\nTiffani: coconut milk in her bowl only." {
		t.Fatalf("notes wrong: %q", got.Notes)
	}
	raw, _ := json.Marshal(got)
	if !strings.Contains(string(raw), `"photos":[{"n":1}]`) {
		t.Fatalf("unknown field dropped: %s", raw)
	}
}

func TestUpdateRefusesTrashAndEmpty(t *testing.T) {
	f := newFake()
	s := newServer(f, "test", nil)
	res, _ := s.updateRecipe(context.Background(), call(map[string]interface{}{"uid": "TRASH", "notes": "x"}))
	if !res.IsError {
		t.Fatal("updated a trashed recipe")
	}
	res, _ = s.updateRecipe(context.Background(), call(map[string]interface{}{"uid": "DAL"}))
	if !res.IsError {
		t.Fatal("update with no fields should error")
	}
	res, _ = s.updateRecipe(context.Background(), call(map[string]interface{}{"uid": "DAL", "name": ""}))
	if !res.IsError {
		t.Fatal("allowed empty name")
	}
	if len(f.saved) != 0 {
		t.Fatal("something was saved")
	}
}

func TestSearchSkipsTrashAndMatchesAllWords(t *testing.T) {
	f := newFake()
	s := newServer(f, "test", nil)
	res, _ := s.searchRecipes(context.Background(), call(map[string]interface{}{"query": "lentils"}))
	out := text(t, res)
	if !strings.Contains(out, "Masoor dal") || strings.Contains(out, "Old lentil thing") {
		t.Fatalf("bad results: %s", out)
	}
	res, _ = s.searchRecipes(context.Background(), call(map[string]interface{}{"query": "chicken ramen"}))
	if out := text(t, res); !strings.Contains(out, "noodle soup") || strings.Contains(out, "dal") {
		t.Fatalf("multi-word search wrong: %s", out)
	}
	res, _ = s.searchRecipes(context.Background(), call(map[string]interface{}{}))
	if out := text(t, res); !strings.Contains(out, "2 of 2 recipes") {
		t.Fatalf("list-all wrong: %s", out)
	}
}

func TestSearchCacheOnlyRefetchesChanged(t *testing.T) {
	f := newFake()
	s := newServer(f, "test", nil)
	_, _ = s.searchRecipes(context.Background(), call(map[string]interface{}{}))
	first := f.gets
	_ = s.refreshCache(context.Background(), true)
	if f.gets != first {
		t.Fatalf("refetched unchanged recipes: %d -> %d", first, f.gets)
	}
	f.recipes["SOUP"].Hash = "h2b"
	_ = s.refreshCache(context.Background(), true)
	if f.gets != first+1 {
		t.Fatalf("expected one refetch, got %d", f.gets-first)
	}
}

func TestCreateRequiresCoreFieldsAndHasNoDeleteTool(t *testing.T) {
	f := newFake()
	s := newServer(f, "test", nil)
	res, _ := s.createRecipe(context.Background(), call(map[string]interface{}{"name": "x"}))
	if !res.IsError {
		t.Fatal("created without ingredients")
	}
	res, _ = s.createRecipe(context.Background(), call(map[string]interface{}{"name": "One-pot chicken", "ingredients": "a", "directions": "b", "source": "House"}))
	if res.IsError || f.saved[0].Source != "House" {
		t.Fatalf("create failed: %s", text(t, res))
	}
	s.registerTools()
	_ = s.server.HandleMessage(context.Background(), json.RawMessage(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`))
	resp := s.server.HandleMessage(context.Background(), json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	b, _ := json.Marshal(resp)
	list := string(b)
	for _, want := range []string{"search_paprika_recipes", "get_paprika_recipe", "create_paprika_recipe", "update_paprika_recipe"} {
		if !strings.Contains(list, want) {
			t.Fatalf("missing tool %s: %s", want, list)
		}
	}
	if strings.Contains(list, `"name":"delete`) || strings.Contains(list, `_delete`) || strings.Contains(list, `delete_`) {
		t.Fatalf("delete tool exposed: %s", list)
	}
}

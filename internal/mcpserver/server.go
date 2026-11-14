package mcpserver

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/soggycactus/paprika-3-mcp/internal/paprika"
)

// paprikaAPI is the slice of the Paprika client this server uses. It is an
// interface so the handlers can be tested without the real API.
type paprikaAPI interface {
	ListRecipes(ctx context.Context) (*paprika.RecipeList, error)
	GetRecipe(ctx context.Context, uid string) (*paprika.Recipe, error)
	SaveRecipe(ctx context.Context, recipe paprika.Recipe) (*paprika.Recipe, error)
}

type NewServerOptions struct {
	Version  string
	Username string
	Password string
	Logger   *slog.Logger
}

func NewServer(opts NewServerOptions) (*Server, error) {
	client, err := paprika.NewClient(opts.Username, opts.Password, opts.Version, opts.Logger)
	if err != nil {
		return nil, err
	}
	return newServer(client, opts.Version, opts.Logger), nil
}

func newServer(api paprikaAPI, version string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		api:    api,
		server: server.NewMCPServer("paprika-3-mcp", version, server.WithToolCapabilities(false)),
		logger: logger,
		cache:  map[string]cachedRecipe{},
	}
}

type cachedRecipe struct {
	hash    string
	trashed bool // kept so trashed recipes aren't refetched every refresh
	recipe  paprika.Recipe
}

type Server struct {
	api    paprikaAPI
	logger *slog.Logger
	server *server.MCPServer

	mu        sync.Mutex
	cache     map[string]cachedRecipe
	refreshed time.Time
}

// How long a recipe index stays fresh before the next search re-checks hashes.
const cacheTTL = 2 * time.Minute

func (s *Server) registerTools() {
	s.server.AddTools(
		server.ServerTool{
			Tool: mcp.NewTool("search_paprika_recipes",
				mcp.WithDescription("Search Paprika recipes by text across name, ingredients, notes, description and source. An empty query lists every recipe. Returns uid, name, rating and source for each match; use get_paprika_recipe for the full recipe."),
				mcp.WithString("query", mcp.Description("Words to search for. All words must match (case-insensitive). Empty lists all recipes."), mcp.DefaultString("")),
				mcp.WithNumber("limit", mcp.Description("Maximum results to return (default 25)."), mcp.DefaultNumber(25)),
			),
			Handler: s.searchRecipes,
		},
		server.ServerTool{
			Tool: mcp.NewTool("get_paprika_recipe",
				mcp.WithDescription("Get one Paprika recipe in full by uid: ingredients, directions, notes, rating, source and categories."),
				mcp.WithString("uid", mcp.Description("The recipe uid from search_paprika_recipes."), mcp.Required()),
			),
			Handler: s.getRecipe,
		},
		server.ServerTool{
			Tool: mcp.NewTool("create_paprika_recipe",
				mcp.WithDescription("Create a new recipe in Paprika. Ingredients and directions are one item per line."),
				mcp.WithString("name", mcp.Description("Recipe name."), mcp.Required()),
				mcp.WithString("ingredients", mcp.Description("Ingredients, one per line."), mcp.Required()),
				mcp.WithString("directions", mcp.Description("Directions, one step per line."), mcp.Required()),
				mcp.WithString("description", mcp.Description("Short description.")),
				mcp.WithString("notes", mcp.Description("Notes.")),
				mcp.WithString("servings", mcp.Description("Servings, e.g. '4'.")),
				mcp.WithString("prep_time", mcp.Description("Prep time, e.g. '15 min'.")),
				mcp.WithString("cook_time", mcp.Description("Cook time, e.g. '35 min'.")),
				mcp.WithString("difficulty", mcp.Description("Difficulty.")),
				mcp.WithString("source", mcp.Description("Source name, e.g. 'America's Test Kitchen'.")),
				mcp.WithString("source_url", mcp.Description("Source URL.")),
			),
			Handler: s.createRecipe,
		},
		server.ServerTool{
			Tool: mcp.NewTool("update_paprika_recipe",
				mcp.WithDescription("Update an existing Paprika recipe. Only the fields you pass change; everything else (photo, rating, categories, source, other fields) is kept. Use append_notes to add to notes without replacing them. Cannot delete recipes."),
				mcp.WithString("uid", mcp.Description("The recipe uid."), mcp.Required()),
				mcp.WithString("name", mcp.Description("New name.")),
				mcp.WithString("ingredients", mcp.Description("Replacement ingredients, one per line.")),
				mcp.WithString("directions", mcp.Description("Replacement directions, one step per line.")),
				mcp.WithString("description", mcp.Description("Replacement description.")),
				mcp.WithString("notes", mcp.Description("Replacement notes (replaces all existing notes).")),
				mcp.WithString("append_notes", mcp.Description("Text to add to the end of the existing notes.")),
				mcp.WithString("servings", mcp.Description("Servings.")),
				mcp.WithString("prep_time", mcp.Description("Prep time.")),
				mcp.WithString("cook_time", mcp.Description("Cook time.")),
				mcp.WithString("difficulty", mcp.Description("Difficulty.")),
				mcp.WithString("source", mcp.Description("Source name.")),
				mcp.WithString("source_url", mcp.Description("Source URL.")),
				mcp.WithNumber("rating", mcp.Description("Rating 0-5.")),
			),
			Handler: s.updateRecipe,
		},
	)
}

func (s *Server) Start() {
	s.registerTools()
	if err := server.ServeStdio(s.server); err != nil {
		s.logger.Error("Server error", "err", err)
	}
}

// refreshCache syncs the local recipe index with Paprika, fetching only recipes
// whose hash changed. Trashed recipes are dropped.
func (s *Server) refreshCache(ctx context.Context, force bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && time.Since(s.refreshed) < cacheTTL {
		return nil
	}

	list, err := s.api.ListRecipes(ctx)
	if err != nil {
		return err
	}

	seen := make(map[string]bool, len(list.Result))
	for _, item := range list.Result {
		seen[item.UID] = true
		if c, ok := s.cache[item.UID]; ok && c.hash == item.Hash {
			continue
		}
		r, err := s.api.GetRecipe(ctx, item.UID)
		if err != nil {
			s.logger.Error("failed to fetch recipe", "uid", item.UID, "err", err)
			continue
		}
		if r.InTrash {
			s.cache[item.UID] = cachedRecipe{hash: item.Hash, trashed: true}
			continue
		}
		s.cache[item.UID] = cachedRecipe{hash: item.Hash, recipe: *r}
	}
	for uid := range s.cache {
		if !seen[uid] {
			delete(s.cache, uid)
		}
	}
	s.refreshed = time.Now()
	return nil
}

// matches reports whether every word of the query appears somewhere in the
// recipe's searchable text.
func matches(r paprika.Recipe, query string) bool {
	words := strings.Fields(strings.ToLower(query))
	if len(words) == 0 {
		return true
	}
	hay := strings.ToLower(strings.Join([]string{
		r.Name, r.Ingredients, r.Notes, r.Description, r.Source, r.SourceURL, r.Directions,
	}, "\n"))
	for _, w := range words {
		if !strings.Contains(hay, w) {
			return false
		}
	}
	return true
}

func stringArg(req mcp.CallToolRequest, key string) (string, bool) {
	v, ok := req.Params.Arguments[key]
	if !ok || v == nil {
		return "", false
	}
	str, ok := v.(string)
	return str, ok
}

func numberArg(req mcp.CallToolRequest, key string) (float64, bool) {
	v, ok := req.Params.Arguments[key]
	if !ok || v == nil {
		return 0, false
	}
	n, ok := v.(float64)
	return n, ok
}

func (s *Server) searchRecipes(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	query, _ := stringArg(req, "query")
	limit := 25
	if n, ok := numberArg(req, "limit"); ok && n > 0 {
		limit = int(n)
	}

	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := s.refreshCache(ctx, false); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("could not reach Paprika: %v", err)), nil
	}

	s.mu.Lock()
	var hits []paprika.Recipe
	total := 0
	for _, c := range s.cache {
		if c.trashed {
			continue
		}
		total++
		if matches(c.recipe, query) {
			hits = append(hits, c.recipe)
		}
	}
	s.mu.Unlock()

	sort.Slice(hits, func(i, j int) bool { return strings.ToLower(hits[i].Name) < strings.ToLower(hits[j].Name) })

	var sb strings.Builder
	fmt.Fprintf(&sb, "%d of %d recipes match", len(hits), total)
	if len(hits) > limit {
		fmt.Fprintf(&sb, " (showing first %d)", limit)
		hits = hits[:limit]
	}
	sb.WriteString(".\n\n")
	for _, r := range hits {
		fmt.Fprintf(&sb, "- %s | uid: %s | rating: %d", r.Name, r.UID, r.Rating)
		if r.Source != "" {
			fmt.Fprintf(&sb, " | source: %s", r.Source)
		}
		if r.SourceURL != "" {
			fmt.Fprintf(&sb, " | %s", r.SourceURL)
		}
		sb.WriteString("\n")
	}
	return mcp.NewToolResultText(sb.String()), nil
}

func formatRecipe(r *paprika.Recipe) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "uid: %s\nrating: %d\n", r.UID, r.Rating)
	if r.Source != "" {
		fmt.Fprintf(&sb, "source: %s\n", r.Source)
	}
	if r.SourceURL != "" {
		fmt.Fprintf(&sb, "source_url: %s\n", r.SourceURL)
	}
	sb.WriteString("\n")
	sb.WriteString(r.ToMarkdown())
	return sb.String()
}

func (s *Server) getRecipe(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	uid, _ := stringArg(req, "uid")
	if uid == "" {
		return mcp.NewToolResultError("uid is required"), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, err := s.api.GetRecipe(ctx, uid)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("could not get recipe %s: %v", uid, err)), nil
	}
	if r.InTrash {
		return mcp.NewToolResultError("that recipe is in the Paprika trash"), nil
	}
	return mcp.NewToolResultText(formatRecipe(r)), nil
}

func (s *Server) createRecipe(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	r := paprika.Recipe{}
	r.Name, _ = stringArg(req, "name")
	r.Ingredients, _ = stringArg(req, "ingredients")
	r.Directions, _ = stringArg(req, "directions")
	if r.Name == "" || r.Ingredients == "" || r.Directions == "" {
		return mcp.NewToolResultError("name, ingredients and directions are required"), nil
	}
	r.Description, _ = stringArg(req, "description")
	r.Notes, _ = stringArg(req, "notes")
	r.Servings, _ = stringArg(req, "servings")
	r.PrepTime, _ = stringArg(req, "prep_time")
	r.CookTime, _ = stringArg(req, "cook_time")
	r.Difficulty, _ = stringArg(req, "difficulty")
	r.Source, _ = stringArg(req, "source")
	r.SourceURL, _ = stringArg(req, "source_url")
	r.Categories = []string{}

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	saved, err := s.api.SaveRecipe(ctx, r)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("could not create recipe: %v", err)), nil
	}
	s.invalidate()
	s.logger.Info("Created recipe", "name", saved.Name, "uid", saved.UID)
	return mcp.NewToolResultText("Created.\n\n" + formatRecipe(saved)), nil
}

// applyUpdate overlays only the fields present in the request onto the
// existing recipe. It returns the list of changed field names.
func applyUpdate(existing *paprika.Recipe, req mcp.CallToolRequest) []string {
	var changed []string
	set := func(key string, dst *string) {
		if v, ok := stringArg(req, key); ok {
			*dst = v
			changed = append(changed, key)
		}
	}
	set("name", &existing.Name)
	set("ingredients", &existing.Ingredients)
	set("directions", &existing.Directions)
	set("description", &existing.Description)
	set("notes", &existing.Notes)
	set("servings", &existing.Servings)
	set("prep_time", &existing.PrepTime)
	set("cook_time", &existing.CookTime)
	set("difficulty", &existing.Difficulty)
	set("source", &existing.Source)
	set("source_url", &existing.SourceURL)

	if add, ok := stringArg(req, "append_notes"); ok && add != "" {
		if strings.TrimSpace(existing.Notes) == "" {
			existing.Notes = add
		} else {
			existing.Notes = strings.TrimRight(existing.Notes, "\n") + "\n\n" + add
		}
		changed = append(changed, "append_notes")
	}
	if n, ok := numberArg(req, "rating"); ok {
		rating := int(n)
		if rating < 0 {
			rating = 0
		}
		if rating > 5 {
			rating = 5
		}
		existing.Rating = rating
		changed = append(changed, "rating")
	}
	return changed
}

func (s *Server) updateRecipe(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	uid, _ := stringArg(req, "uid")
	if uid == "" {
		return mcp.NewToolResultError("uid is required"), nil
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	// Always start from the current copy so untouched fields survive.
	existing, err := s.api.GetRecipe(ctx, uid)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("could not load recipe %s: %v", uid, err)), nil
	}
	if existing.InTrash {
		return mcp.NewToolResultError("that recipe is in the Paprika trash; not updating it"), nil
	}

	changed := applyUpdate(existing, req)
	if len(changed) == 0 {
		return mcp.NewToolResultError("no fields to update were given"), nil
	}
	if existing.Name == "" {
		return mcp.NewToolResultError("a recipe name cannot be empty"), nil
	}

	saved, err := s.api.SaveRecipe(ctx, *existing)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("could not save recipe: %v", err)), nil
	}
	s.invalidate()
	s.logger.Info("Updated recipe", "name", saved.Name, "uid", saved.UID, "fields", changed)
	return mcp.NewToolResultText(fmt.Sprintf("Updated %s.\n\n%s", strings.Join(changed, ", "), formatRecipe(saved))), nil
}

func (s *Server) invalidate() {
	s.mu.Lock()
	s.refreshed = time.Time{}
	s.mu.Unlock()
}

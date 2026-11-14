package paprika

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRecipeRoundTripKeepsUnknownFields(t *testing.T) {
	in := `{"uid":"ABC","name":"Dal","photos":[{"name":"p1.jpg"}],"some_future_field":42,"rating":4,"categories":["X"]}`
	var r Recipe
	if err := json.Unmarshal([]byte(in), &r); err != nil {
		t.Fatal(err)
	}
	if r.Name != "Dal" || r.Rating != 4 {
		t.Fatalf("known fields not decoded: %+v", r)
	}
	out, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"photos":[{"name":"p1.jpg"}]`, `"some_future_field":42`, `"rating":4`, `"categories":["X"]`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
}

func TestUpdateCreatedKeepsExistingDate(t *testing.T) {
	r := Recipe{Created: "2024-01-02 03:04:05"}
	r.updateCreated()
	if r.Created != "2024-01-02 03:04:05" {
		t.Fatalf("created date was reset to %s", r.Created)
	}
	n := Recipe{}
	n.updateCreated()
	if n.Created == "" {
		t.Fatal("new recipe got no created date")
	}
}

func TestHashIncludesUnknownFields(t *testing.T) {
	var a, b Recipe
	_ = json.Unmarshal([]byte(`{"uid":"A","name":"x","photos":[1]}`), &a)
	_ = json.Unmarshal([]byte(`{"uid":"A","name":"x","photos":[2]}`), &b)
	_ = a.updateHash()
	_ = b.updateHash()
	if a.Hash == b.Hash {
		t.Fatal("hash ignores unknown fields")
	}
}

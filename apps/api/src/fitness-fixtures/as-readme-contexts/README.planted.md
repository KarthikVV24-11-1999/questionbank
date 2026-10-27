Four bounded contexts, each under `apps/api/src/contexts/`:

```
apps/api
 ├─ contexts/curriculum/  taxonomy
 ├─ contexts/scoring/     marking
 └─ contexts/ghost/       a context that was removed
```

| Context | Owns | Depends on |
|---|---|---|
| `curriculum` | Taxonomy | nothing |
| `scoring` | Marking | nothing |
| `ghost` | Nothing | nothing |

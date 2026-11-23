# Read-only kontrola spójności backlogu i GitHub (TECH/DEV/QA)

Pierwsza wersja skryptu: `scripts/governance-audit.mjs`. Jest **read-only**. Nie korzysta z tokenów ani automatycznie nie zmienia statusów. Służy do wykrywania braków w eksporcie aktualnych kart Notion i metadanych PR/CI dla dokładnego SHA.

## Wejście

1. Z Notion wyeksportuj aktualne wiersze z jednego backlogu do lokalnego JSON. Minimalnie: `userDefined:ID`, `Status`, `Agent prowadzący`, `Recenzent`, `Bloker`, `Dowody`. Akceptowany format: tablica albo `{"results":[...]}.`
2. Z GitHub pobierz metadane PR i aktualne workflow runy do lokalnego JSON. Akceptowane pola: `pullRequests` (lub `pull_requests` / `pulls`) i opcjonalnie `workflowRuns` (lub `workflow_runs`). Dla PR potrzebne `number,state,draft,head.sha,base.ref`. Dla runu `head_sha,status,conclusion`, a dla pełnej weryfikacji `jobs:[{name,conclusion}]` dla `build`, `windows-application`, `msix-lifecycle`.
3. Zapisz pliki **poza repozytorium**, bo raporty mogą zawierać nazwy klientów i wewnętrzne informacje. Nie zapisuj tokenów, plików SQLite ani produkcyjnych danych do git.

Minimalny przykład syntetyczny:

```json
{"tasks":[{"userDefined:ID":"DEV-24","Status":"W realizacji","Agent prowadzący":"","Bloker":"Odbiór Windows 11","Dowody":"https://github.com/example/tracker/pull/63"}]}
```

```json
{"pullRequests":[{"number":63,"state":"open","draft":true,"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"base":{"ref":"main"}}],"workflowRuns":[{"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"completed","conclusion":"success","jobs":[{"name":"build","conclusion":"success"},{"name":"windows-application","conclusion":"success"},{"name":"msix-lifecycle","conclusion":"success"}]}]}
```

## Uruchomienie

```powershell
node --test tests/governanceAudit.test.mjs
node scripts/governance-audit.mjs --notion C:\Temp\notion-tasks.json --github C:\Temp\github-pr-ci.json
```

Opcja `--strict` zwraca kod wyjścia 1 przy błędach danych (brak ID, nieznany status, brak blokera/dowodu). Ostrzeżenia (brak recenzenta, właściciela, nierozstrzygnięty PR) nigdy nie zmieniają statusów automatycznie. `CI_JOB_DETAILS_NOT_PROVIDED` oznacza, że potwierdzono workflow `SUCCESS`, ale nie dostarczono jobów; skrypt **nie** twierdzi wtedy, że każdy job jest potwierdzony.

## Wykrywane przypadki

- Nieznane/zdublowane ID i statusy, puste pola dla aktywnych, weryfikowanych i zablokowanych zadań.
- Nieaktualny zamknięty PR wskazany jako aktywny bloker; historyczne adnotacje są wyłączane.
- `Zrobione` powołujące się na Draft PR — wymaga sprawdzenia, nie automatycznego cofnięcia statusu.
- Brak CI na **dokładnym SHA** bieżącego PR i brak dowodu uruchomienia trzech jobów.
- PR bazujący na innej gałęzi niż `main` (stacked PR).

## Granice automatyzacji

To weryfikator **snapshotów**. Nie ma dostępu na żywo do Notion ani do GitHub bez dostarczonego aktualnego eksportu i nie zapewnia pełnego pokrycia wszystkich 55 kart, jeśli wejście ma mniej rekordów. Nie weryfikuje treści każdego acceptance criterion, podpisu Store ani niezależnej tożsamości recenzenta. Nie wykorzystuj jego wyniku jako QA PASS. Docelowa integracja API/GitHub Actions wymaga osobnego projektu uprawnień i testów; nie zapisuj tokenów w kodzie.

Powiązane zasady: [WORKFLOW-GOVERNANCE.md](WORKFLOW-GOVERNANCE.md) w PR #66. Ten audyt jest osobnym małym PR i wymaga oddzielnej akceptacji scalania.

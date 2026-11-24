# TrackerMaster — MSIX do prywatnej dystrybucji w Microsoft Store (D11)

Zakres tego dokumentu (PR A): **jeden** szablon manifestu, **jeden** skrypt pakujący i kandydat Store budowany ręcznie z `main`. Nic tu nie jest podpisywane, przesyłane do Partner Center ani publikowane. Cykl życia wariantu Store w CI (PR B) oraz runbook Partner Center i materiały listingu (PR C) są osobnymi krokami.

## Warianty i pliki

| Plik | Rola |
|---|---|
| `packaging/msix/AppxManifest.template.xml` | Jedyny szablon manifestu. Wartości `@…@` uzupełnia skrypt. |
| `packaging/msix/identities.json` | Jedyne źródło tożsamości: `test` (CI) i `store` (Partner Center). |
| `packaging/msix/New-TestMsix.ps1` | Jedyny skrypt pakujący: `-Variant Test` (domyślnie) lub `-Variant Store`; `-ManifestOnly` zapisuje sam manifest. |
| `packaging/msix/Test-MsixManifestParity.ps1` | Sprawdza, że manifest Store = manifest testowany (poza tożsamością i nazwami). |
| `.github/workflows/windows-msix-store.yml` | Kandydat Store: tylko `workflow_dispatch` z `main`. |

- **Test** (`TrackerMaster.TestOnly`): budowany na każdym PR i w `main`, instalowany w CI (`msix-lifecycle`: instalacja, aktualizacja, odinstalowanie i ponowna instalacja z zachowaniem danych; DEV-14 `-Mode Packaged`).
- **Store** (`vatlar.TrackerMaster`, `CN=EBE2824B-F077-49B4-A180-73C366094CBA`, `vatlar` — wartości z Partner Center podane przez właściciela 20.11.2026): na PR powstaje **wyłącznie manifest** do porównania, bez pakietu. Pakiet z tożsamością Store powstaje tylko ręcznie z `main`. Zgodności tych wartości z rezerwacją w Partner Center nie da się sprawdzić z repozytorium (BLOCKED do zgłoszenia).

Manifest Store różni się od testowanego tylko polami `Identity/@Name`, `Identity/@Publisher`, `PublisherDisplayName`, `DisplayName` i `Description`. Oba: `MinVersion 10.0.22000.0` (Windows 11 zgodnie z D11), bez `desktop6:FileSystemWriteVirtualization`, z tymi samymi capability i tym samym folderem wyłączonym z wirtualizacji. Pilnuje tego `Test-MsixManifestParity.ps1` w CI na każdym PR.

## Izolacja pakowanej binarki

Pakowany jest wyłącznie build testowy: `VITE_TRACKER_TEST_MODE=1` i `src-tauri/tauri.isolated.conf.json` (profil danych `%APPDATA%\pl.tracker.personal.testonly`). `build.rs` ustala efektywny identyfikator tak jak `tauri-build` (plik `tauri.conf.json` + nakładka `TAURI_CONFIG` z `--config`) i osadza w pliku EXE znacznik:

- `TRACKERMASTER_BUILD_PROFILE=testonly;` — tylko dla identyfikatora `pl.tracker.personal.testonly` **i** `VITE_TRACKER_TEST_MODE=1`;
- `TRACKERMASTER_BUILD_PROFILE=production;` — w każdym innym buildzie.

`New-TestMsix.ps1` odmawia pakowania bez znacznika `testonly`. Sam literał `pl.tracker.personal.testonly` nie wystarcza, bo jest też w kodzie produkcyjnym. W CI krok „Refuse to package a production build” buduje wersję produkcyjną i wymaga, żeby oba warianty (`Test` i `Store`) odmówiły pakowania. Wersji produkcyjnej nie uruchamia, więc profil `pl.tracker.personal` nie jest dotykany.

**Wspólny profil na komputerze właściciela:** pakiet Store i niepodpisany `tracker-master.exe` z artefaktu CI używają tego samego profilu `pl.tracker.personal.testonly` (baza, `instance.lock`, szkice). Nie uruchamiaj ich naraz i nie traktuj danych z jednego jako niezależnych od drugiego. To wersja do testów na danych fikcyjnych: przejście tego samego produktu na profil `pl.tracker.personal` zmieni katalog danych bez migracji (decyzja właściciela, punkt „Decyzje” niżej).

## Kandydat Store: jak zbudować

1. GitHub → Actions → **TrackerMaster Store MSIX candidate** → *Run workflow* na gałęzi `main`.
2. `package_version`: cztery liczby, ostatnia `0`, wyższa niż każda wersja już przesłana do Partner Center (np. `0.1.0.0`, potem `0.1.1.0`). Store wymaga `.0` na końcu i nie przyjmie wersji niższej ani równej już przesłanej; aktualizację u użytkownika dostarcza Store po certyfikacji nowej wersji (odbiór R03 na Windows 11).
3. Wynik to artefakt `TrackerMaster-Store-candidate-<wersja>-src-<12 znaków SHA>-sha256-<16 znaków>`. W środku:
   - `TrackerMaster-Store-candidate-<wersja>-x64.msix`;
   - `candidate.txt`: SHA źródła, wersja, pełny SHA-256, tożsamość, profil danych, link do przebiegu.

   Te same wartości są w logu i w podsumowaniu przebiegu.
4. Przed przesłaniem porównaj SHA-256 pobranego pliku z `candidate.txt`, a SHA źródła ze zrecenzowanym commitem.

Pakiet jest **niepodpisany** i nie nadaje się do instalacji dwuklikiem; podpisuje go Microsoft Store po certyfikacji. Repozytorium i artefakty GitHub Actions są **publiczne** — nie są prywatnym kanałem dystrybucji.

## Ryzyka do decyzji właściciela

- **`unvirtualizedResources` (restricted capability)** — zostawiona **bez zmian**, tak jak w manifeście testowanym w `main`; ta zmiana o niej nie decyduje.
  - Przy zgłoszeniu do Store wymaga uzasadnienia w Partner Center → Submission options → Restricted capabilities i może zostać odrzucona.
  - Bez niej zapisy do `%APPDATA%` trafiają do `LocalCache` pakietu i są usuwane przy odinstalowaniu, więc R02 (dane po odinstalowaniu i ponownej instalacji) w obecnym brzmieniu D11 nie przejdzie.
  - Możliwe wyjścia: (a) uzasadnienie i zatwierdzenie capability; (b) decyzja, że odinstalowanie usuwa dane, plus obowiązkowa kopia przed odinstalowaniem; (c) inny, niewirtualizowany katalog danych — to zmiana produktu wymagająca testów.
- **Windows 10**: poza zakresem (`MinVersion 10.0.22000.0`). Wariant dla Windows 10 wymagałby osobnego testu cyklu życia.
- **Profil `testonly`**: czy pierwszy pakiet Store służy tylko do odbioru na danych fikcyjnych, czy od razu do codziennej pracy.

## Czego ten etap nie potwierdza (BLOCKED bez Partner Center i podpisu)

Zgodność tożsamości i nazwy z rezerwacją; zatwierdzenie restricted capabilities; certyfikacja i podpis Store; Private audience i próba obcego konta (R01); instalacja ze Store, WebView2, skrót globalny, DPI i Smart App Control na Windows 11; aktualizacja przez Store (R03); trwałość danych po odinstalowaniu i ponownej instalacji prawdziwego pakietu (R02).

Źródła Microsoft:
- https://learn.microsoft.com/en-us/windows/apps/publish/store-readiness-checklist
- https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization

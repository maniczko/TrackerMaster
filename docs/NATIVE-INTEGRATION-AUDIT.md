# TrackerMaster — porównanie z referencyjnym preview v0.6 (16.11.2026)

## Źródło i granice

Wersja `TrackerMaster_Development_Preview_v0.6.zip` z rozmowy ChatGPT to **oddzielna aplikacja Node.js/SQLite z interfejsem webowym**, podczas gdy to repozytorium to **Tauri 2 + Rust + React/TypeScript + SQLite**. Liczba 77/77 oznacza testy preview Node.js i **nie jest** wynikiem testów aplikacji natywnej. Nie wolno kopiować pliku SQLite ani migracji schema=5 z preview do natywnej bazy schema=3.

## Weryfikacja funkcji

| Funkcja | Stan w oryginalnym repo | Co wnosi ten PR |
| --- | --- | --- |
| Klient / projekt / zadanie | Istnieje | Bez zmian |
| Start, stop, atomowe przełączenie | Istnieje w Rust z testami | Bez zmian |
| Odtworzenie po restarcie | Istnieje, ręczne podanie czasu | Bez zmian; polityka uśpienia D4/D12 otwarta |
| Liczniki Windows / rozbieżność zegara | Istnieje przy stop / switch | Bez zmian; brak ciągłego monitoringu |
| Jedna instancja | Blokada pliku Windows istnieje | Bez zmian |
| Kontrola schematu bieżącej bazy | Istnieje dla wersji 3 | **Nowy wczesny preflight** przed `Connection::open` i DDL dla istniejących plików, także legacy; sprawdzane SQLite integrity / FK |
| Kopia bazy online | Brak | **Nowy natywny backup** z `VACUUM INTO` do katalogu danych i walidacją przed opublikowaniem |
| Przywrócenie kopii | Brak | Nie wdrożono; bez uzgodnionego D7/D8 brak bezpiecznej podmiany plików |
| Rozbudowany kalendarz / raporty / CSV | Brak | Nie wdrożono; wymagają mapowania na natywny model danych oraz decyzji D10/D12 |
| Serwer Node.js i ochrony Origin/Host | Nie dotyczy natywnego backendu IPC | Nie importowano serwera ani jego zabezpieczeń |
| Zewnętrzne tokeny Notion | Nie podłączono | Nie wprowadzono tokenów ani telemetrii |

## Jak działa kopia

Z poziomu głównego okna można użyć przycisku **Utwórz kopię bazy**. Rust używa SQLite `VACUUM INTO`, więc pomiar nie musi zostać zatrzymany. Najpierw tworzony jest plik `.partial` w `app_data_dir/backups`, walidowany na osobnym połączeniu w trybie read-only i dopiero przenoszony do końcowego pliku `.sqlite3`. Nie tworzy się kopii przez bezwarunkowe kopiowanie pracującego pliku z WAL. Przy błędzie częściowy plik jest usuwany best-effort. Kopie **nie są szyfrowane**; nie przenosić ich do współdzielonych lokalizacji bez ochrony.

Wersja natywnej bazy pozostaje **3**, nie migrujemy na schemat preview Node.js. Jeśli baza już istnieje i jest pusta/uszkodzona/brakuje jej tabel, start zostaje przerwany bez automatycznego naprawiania danych. Pierwsze uruchomienie bez pliku pozostaje obsługiwane.

## Testy zapisane w kodzie Rust

W `src-tauri/src/storage_safety.rs` dodano przypadki:
- brak pliku vs istniejący pusty plik;
- niekompletny schemat bez cichej naprawy;
- zły nagłówek/plik SQLite;
- legacy bez wersji z danymi oraz migracja do wersji 3;
- spójny backup z aktywnym i zamkniętym pomiarem przy włączonym WAL;
- odmowa publikacji kopii z nieprawidłowego źródła.

## Odbiór / bramki

Oczekiwane polecenia na Windows:

```powershell
npm ci
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --no-bundle
```

Repo ma workflow `.github/workflows/windows-build.yml` wykonujący te kontrole na GitHub Actions. Wynik należy sprawdzić po push/PR; z samego utworzenia kodu nie wynika PASS. Dodatkowo sprawdzić ręcznie na **fikcyjnej bazie**: backup z uruchomionym timerem, otwarcie kopii i porównanie klientów/projektów/zadań/wpisów, weryfikację braku pliku `.partial` po udanym backupie, oraz start na niekompletnej bazie (bez naprawy).

**Status:** częściowe przeniesienie, wymaga CI, sprawdzenia Windows i review. Nie zamyka DEV-03, DEV-13, DEV-14. Kopie i katalogi testowe mogą zawierać dane poufne; repo nie powinno zawierać rzeczywistych plików SQLite.

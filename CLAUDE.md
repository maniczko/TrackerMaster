# TrackerMaster — aktualne instrukcje dla agentów

**Data przeglądu: 23.11.2026.** Przed działaniem odczytaj aktualny HEAD repozytorium i karty Notion. Ten plik opisuje proces, nie stan bieżącego CI.

## Priorytet i źródła prawdy

1. **Bezpieczeństwo czasu i danych**: brak niekontrolowanej utraty, podwójnego naliczania, domyślnego akceptowania niepewnego czasu; w niepewności odmowa zapisu (`fail closed`).
2. **Wymagania i decyzje**: Notion [główny backlog](https://app.notion.com/p/418e1de1f67a8152928dfe2ccb01db64); D1–D13 zatwierdzone. D11 końcowe = **MSIX / Microsoft Store Private audience**, zastępuje historyczne produkcyjne NSIS i OneDrive. D1 = MVP offline; D9 = V1.2 import Notion, bez wysyłania czasu.
3. **Kod**: `main` jako zatwierdzona implementacja; Draft PR to tylko kandydaci. Weryfikuj SHA `main` i HEAD każdego PR.
4. **Testy i dowody**: GitHub Actions uruchomione **dla dokładnego SHA**, wyniki poszczególnych jobów i testów, artefakty, recenzent. Windows Server CI nie zastępuje docelowego Windows 11.
5. **Plan i raportowanie**: [PROJECT-STATUS](docs/PROJECT-STATUS.md) (migawka, nie automatyczna prawda), [WORKFLOW-GOVERNANCE](docs/WORKFLOW-GOVERNANCE.md), [QA-MVP-ACCEPTANCE-MATRIX](docs/QA-MVP-ACCEPTANCE-MATRIX.md).

## Implementacja i testy

- Stos: Tauri 2 / React / TypeScript / Rust / lokalna SQLite; docelowy MVP Windows 11 x64, tylko aktualny użytkownik.
- Klient i projekt obowiązkowe, zadanie opcjonalne; tylko jeden timer, atomowe przełączenie. Zaakceptowany kontrakt czasu D12, raportów, CSV i niepewnego uśpienia ma pierwszeństwo przed wariantami historycznymi.
- **Wersję SQLite wyznacza wyłącznie `LATEST_SCHEMA_VERSION` w `src-tauri/src/main.rs`**. Migawka 23.11: v14 (`auto_included` dla krótkiego uśpienia). Nigdy nie utrwalaj numeru migawki jako stałej w nowym kodzie.
- Migracje wymagają transakcji, kopii i weryfikacji integralności; starsza aplikacja odrzuca nowszą bazę.
- Zakaz prawdziwych danych klientów w testach. Używaj profilu `pl.tracker.personal.testonly` i syntetycznych fixture.
- Standard: `npm ci`, `npm run build`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`. Rzeczywistą listę testów Node odczytaj z `.github/workflows/windows-build.yml`; nowe testy dodaj jawnie do workflow. TECH-09 i TECH-10 mają też osobne testy kontraktu.
- Jeśli Windows blokuje niepodpisany program (`4551`), **nie wyłączaj Smart App Control, Code Integrity ani kontroli aplikacji**. Korzystaj z Windows CI; finalny pakiet musi działać z ochroną.
- `preview:ui` to mockowany podgląd interfejsu, nie test aplikacji natywnej ani certyfikacji Store.

## Zarządzanie PR i zadaniami

1. Przed zmianą ustal ID PTT/DEV/TECH/QA i zakres MVP/V1.1/V1.2, sprawdź czy funkcja nie istnieje już na `main`.
2. Jeden PR = mały, niezależnie testowalny fragment. Preferuj Draft, rejestruj bazę, HEAD, zależności i ryzyka; nie wprowadzaj do `main` niezaakceptowanych rozszerzeń.
3. Sprawdzaj **build, windows-application i msix-lifecycle** na HEAD, jeśli dotyczą zmiany; osobne testy kontraktu według zmian. Green workflow bez faktycznego uruchomienia nowego testu nie wystarczy.
4. Autor może oznaczyć `Do weryfikacji`, ale `Zrobione` dopiero po niezależnej recenzji z dowodami; QA Windows 11 oraz akceptacja wydania to odrębne bramki.
5. Żadnego merge `main` ani wydania/publikacji Store bez wyraźnej zgody PO w bieżącym zleceniu. Nie usuwaj cudzych gałęzi, nie osłabiaj testów.
6. Notion: zapisuj osobno `kod w Draft`, `kod na main`, `CI PASS`, `QA Windows 11`, `PO accepted`. Status `Zablokowane` wyjaśniaj realną blokadą i nie ukrywaj trwającego rozwoju na gałęzi.
7. PR #8 **zamknięto bez merge** po wydzieleniu zmian. Nie kontynuuj nieaktualnego planu wydzielania PR #8; sprawdź już scalone wycinki oraz aktywne PR #63–#65.

## Bramka wydania

**MVP pozostaje nieodebrane.** Wymaga podpisanego zaufanego MSIX w zatwierdzonym kanale dystrybucji, rzeczywistego Windows 11 x64, instalacji i aktualizacji bez utraty danych, zachowania SQLite po odinstalowaniu, testu offline, tray/skrótów, uśpienia i pełnego dnia użytkowania, a następnie niezależnego DEV-15/QA-01. Fizyczny przycisk USB jest poza obowiązkową bramką MVP.

Historia wcześniejszych instrukcji agentów: [docs/archive/CLAUDE-20261120.md](docs/archive/CLAUDE-20261120.md).

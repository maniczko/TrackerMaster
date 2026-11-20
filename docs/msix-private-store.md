# TrackerMaster — prywatne testy w Microsoft Store (MSIX)

Zakres: **wyłącznie izolowana wersja testowa**, bez danych klientów, bez publikacji i bez scalenia do `main` bez zgody właściciela. Ten etap tworzy niepodpisany pakiet MSIX. Store podpisuje go po zatwierdzeniu zgłoszenia.

## Gdzie szukać paczki

- Na PR dla tego workflow: GitHub Actions → `TrackerMaster private Store MSIX` → Artifacts → `TrackerMaster-isolated-MSIX-pull_request`.
- **Artefakt z PR jest demonstracyjny**: ma `TrackerMaster.TestOnly` i **nie pasuje** do zarezerwowanej tożsamości Partner Center. Nie przesyłać go do Store.
- Po zaakceptowaniu i scaleniu PR można uruchomić `workflow_dispatch` z tożsamością ze Store. Wynik: `TrackerMaster-isolated-MSIX-workflow_dispatch`, wewnątrz `TrackerMaster-private-store-candidate-x64.msix`.
- Pakiet jest niepodpisany. Nie jest przeznaczony do lokalnego instalowania przez dwuklik. Do instalowania prywatnie użyj certyfikacji i podpisu Microsoft Store. Lokalne testy instalacji/aktualizacji wymagają osobnej podpisanej paczki deweloperskiej i Windows 11.

## Wejście w Microsoft Partner Center

Na ekranie TrackerMaster → Product management → **Product Identity** skopiuj dokładnie:

1. `Package/Identity/Name` → `package_name`,
2. `Package/Identity/Publisher` → `publisher`,
3. `Package/Properties/PublisherDisplayName` → `publisher_display_name`.

Wartości muszą dokładnie zgadzać się z tożsamością produktu; nie zamieniaj widocznej nazwy „TrackerMaster” na `Package/Identity/Name` bez sprawdzenia. Ustal także `package_version` (np. `0.1.0.0`; czwarta część wersji równa zero).

Na GitHub → Actions → `TrackerMaster private Store MSIX` → **Run workflow** wprowadź trzy wartości tożsamości i wersję. Nie uruchamiaj builda z danymi produkcyjnymi; aplikacja używa `pl.tracker.personal.testonly`.

Po PASS pobierz artefakt z tego konkretnego uruchomienia i ręcznie prześlij MSIX do Partner Center → **Packages**. Zanim wyślesz certyfikację, upewnij się, że **Pricing and availability → Private audience** zawiera tylko Twoje konto do testów.

## Co sprawdza automat

- Zakaz plików SQLite śledzonych przez Git.
- Build Tauri 2 w trybie release, z nadpisaną tożsamością `pl.tracker.personal.testonly`.
- Sprawdzenie architektury x64 i obecności identyfikatora izolowanej aplikacji w EXE.
- Przygotowanie manifestu z danymi Partner Center, użycie Microsoft SDK MakeAppx oraz rozpakowanie MSIX w celu porównania tożsamości i obecności EXE.
- Wyliczenie SHA-256 wygenerowanej paczki.

**Czego ten automat nie potwierdza:** poprawnej instalacji, uruchomienia i aktualizacji na czystym Windows 11, działania WebView2 i skrótów globalnych po instalacji, zachowania SQLite po odinstalowaniu, akceptacji ograniczonej capability `unvirtualizedResources` ani przejścia certyfikacji Store. Te punkty pozostają QA/BLOCKED do momentu dostarczenia dowodów.

## Ważne ograniczenia

- Repozytorium GitHub jest aktualnie **publiczne**. Nie traktuj artefaktów GitHub Actions jako prywatnego kanału dystrybucji. Jeśli celem jest wyłączny dostęp do binariów, trzeba oddzielnie zabezpieczyć repozytorium lub kanał buildów.
- Manifest zawiera `unvirtualizedResources` oraz wykluczenie profilu SQLite z wirtualizacji, aby wspierać wymaganie zachowania danych po odinstalowaniu. Jest to *restricted capability* i może wymagać uzasadnienia w Partner Center. Zachowanie danych musi zostać zweryfikowane na Windows 11.
- MSIX z tego PR **nie** publikuje produktu ani nie dodaje odbiorców. Wysyłka do certyfikacji jest oddzielną, ręczną decyzją właściciela.
- Workflow po uruchomieniu z `workflow_dispatch` wymaga zatwierdzonego scalenia PR do domyślnej gałęzi, na której zarejestrowana jest definicja workflow.

Źródła Microsoft:
- https://learn.microsoft.com/en-us/windows/apps/publish/store-readiness-checklist
- https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/tauri
- https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization

# Podgląd interfejsu w przeglądarce

Narzędzie do oceny wyglądu bez uruchamiania aplikacji Windows. Przydaje się, gdy niepodpisanych buildów nie da się uruchomić, np. przez Smart App Control.

```powershell
npm ci
npm run preview:ui
```

Następnie otwórz `http://127.0.0.1:1430/preview.html`. Strona pokazuje obok siebie mini widget (440×76, po rozwinięciu 440×390) i okno główne (1280×720), z przełącznikiem scenariuszy:

- **Pomiar w trakcie**
- **Brak pomiaru**
- **Do weryfikacji (po zamknięciu procesu)**
- **Niepewny czas po uśpieniu**

Skalę DPI 125% i 150% przybliża powiększenie przeglądarki (Ctrl +).

## Ograniczenia

- Backend jest udawany (`preview/mockCore.ts`): fikcyjne dane w pamięci, znikają po odświeżeniu.
- Akcje, których podgląd nie modeluje (archiwizacja, kopie, przywracanie, korekty, szkice itd.), kończą się komunikatem „Ta akcja nie jest dostępna w podglądzie interfejsu” zamiast fałszywego sukcesu.
- **Nie sprawdza** bazy SQLite, migracji, uśpienia i wybudzenia, skrótu globalnego, traya, okien Windows, WebView2 ani MSIX. Nie zastępuje odbioru na Windows 11 (UIQ-09, DEV-15, QA-01).
- Wygląd odpowiada Chromium/Edge, którego silnik ma też WebView2, ale fonty systemowe, skalowanie DPI i krawędzie okien mogą się różnić.

## Izolacja od aplikacji

Mocki są podpinane wyłącznie przez `vite.preview.config.ts`. Test `tests/previewIsolation.test.mjs` pilnuje, żeby:

- kod w `src/` nie importował mocków;
- `vite.config.ts` (build aplikacji) nie podmieniał API Tauri;
- konfiguracja podglądu podmieniała każdy moduł Tauri używany przez aplikację;
- zbudowany bundle nie zawierał kodu podglądu.

## Kalendarz (tydzień, pakiet A)

Przełącznik **Timer / Kalendarz** jest pod nagłówkiem okna głównego. Podgląd ma wpisy na każdy z 7 dni przed dzisiejszym, wpis przez północ (wczoraj 23:30 – dziś 00:45), jedno uśpienie do rozstrzygnięcia (zakreskowane, nieliczone) i w scenariuszu „Pomiar w trakcie” żywy blok z linią „teraz”. W scenariuszach „Do weryfikacji” i „Niepewny czas” aktywny pomiar jest zakreskowany i nie wlicza się do sum.

Bezpośrednie adresy (tylko podgląd):

- `http://127.0.0.1:1430/index.html?scenario=running&view=calendar` — bieżący tydzień;
- `…&view=calendar&week=2026-11-16` — tydzień, w którym jest podany dzień;
- `…&view=timer` — powrót do widoku Timer.

Sumy dni i tygodnia liczy ta sama funkcja co raport (`makeReportView` → `reportByDay`).

## Kalendarz: dodawanie i edycja (pakiet B, DEV-26)

- **Klik pustego miejsca** w kolumnie dnia otwiera „Nowy wpis” od najbliższego wcześniejszego kwadransa, z końcem 30 minut później. Z klawiatury to samo daje przycisk **+ Wpis** obok wyboru daty.
- **Klik zakończonego wpisu** otwiera ten sam formularz w trybie edycji: godziny, opis i rozliczalność. Klienta, projektu ani zadania zapisanego wpisu nie zmienisz. Trwający pomiar, pomiar do weryfikacji i wpis z uśpieniem do rozstrzygnięcia pokazują tylko szczegóły.
- Formularz od razu pokazuje błędy po polsku: nakładanie się na inny pomiar, koniec nie po początku, czas w przyszłości, nieistniejąca (29.03) lub powtórzona (25.10) godzina przy zmianie czasu.
- Enter zapisuje, Esc zamyka bez zapisu, Tab nie wychodzi poza okno dialogu.
- `…&failsave=1`: pierwszy zapis kończy się błędem zapisu danych lokalnych. Formularz zostaje z danymi, a „Spróbuj ponownie” zapisuje raz. Tak w podglądzie klika się ścieżkę błędu zapisu.

Mock w `preview/mockCore.ts` sprawdza te same reguły i zwraca te same komunikaty co backend, ale to nie jest backend: atomowość zapisu, szkice na dysku i ponowienie bez duplikatu sprawdzają testy Rust i E2E Windows.

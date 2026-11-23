# TECH-06 — Macierz testów i odbioru MVP TrackerMaster

**Data opracowania:** 2026-11-17  
**Źródła:** Notion „Backlog — Personal Time Tracker”: PTT-01–PTT-41, TECH-06, DEV-15, QA-01 oraz decyzje D1–D13; GitHub `main` bazowo `d9f70423d9cb2ffff0ed22d6308fb08c7da3de8c`.  
**Status dokumentu:** PLAN QA zaktualizowany o finalne D11/D12 — do niezależnego odbioru TECH-06. Wszystkie wyniki testów aplikacji to **NOT RUN**; dokument nie jest protokołem odbioru DEV-15/QA-01.  
**Kryterium pokrycia:** 30 wymaganych w backlogu pozycji oznaczonych *MVP + Must* (PTT-05 i PTT-21 mają priorytet Should, więc nie są bramką Must). „Must” to priorytet wpisu, nie dowód zatwierdzonej akceptacji każdej karty PTT — właściwość Akceptacja wymaga odrębnego rozstrzygnięcia. Decyzje biznesowe D11/D12 są finalnie zatwierdzone od 17.11.2026; wykonanie DEV i QA to osobne bramki.

## 1. Środowisko, dane i zasady

- **System odbiorowy:** czysty Windows 11 x64, zwykłe konto użytkownika, ochrony Windows aktywne (w tym aktualne ustawienia Smart App Control / Code Integrity), instalacja z docelowego pakietu. Nie wyłączać ochrony w celu zaliczenia testów.
- **Aktualna decyzja dystrybucyjna D11 (17.11.2026):** *Microsoft Store, MSIX, Private audience, Free, pierwszy odbiorca = jedyne osobiste MSA właściciela*. Wcześniejsze instrukcje o NSIS należy traktować jako historyczne, a nie aktualną bramkę wydania. Konto Partner Center, paczka i prywatna grupa muszą zostać rzeczywiście skonfigurowane i niezależnie zweryfikowane; samo spisanie decyzji nie jest PASS.
- **Dane wyłącznie syntetyczne:** klient **K-A „Test Alfa”**, klient **K-B „Test Beta”**; każdy ma projekt **„Wspólny”** z odrębnymi ID oraz zadania **A1, A2, B1**. Dodatkowo wpisy datowane na **2026-03-29** i **2026-10-25** dla przejść DST w `Europe/Warsaw`. Nie używać danych realnych klientów ani produkcyjnych kont.
- **Uruchomienie:** zalogować konto standardowe, odłączyć internet w zadanych scenariuszach; zapisać architekturę, build Windows, commit, wersję aplikacji/pakietu, `user_version` SQLite, strefę IANA, hash pakietu, stan kontroli aplikacji i ścieżkę danych (bez pełnych danych konta).
- **Bezpieczeństwo testów awaryjnych:** używać tylko izolowanego profilu/VM i kopii fikcyjnej bazy. Symulować brak miejsca, przerwanie procesu, niezgodną kopię i zmianę zegara **wyłącznie** w piaskownicy. Nie niszczyć bieżących danych ani nie instalować niepodpisanej wersji przez wyłączanie zabezpieczeń.
- **Wynik testu:** `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. `PASS` wymaga **wykonanego** scenariusza i dowodu. Testu bez docelowego sprzętu/pakietu nie oznaczać PASS; brak Must jest BLOCKED dla bramki QA-01.

## 2. Macierz: wymagania Must MVP → scenariusze

| Wymaganie | Priorytet / wersja | Testy akceptacyjne |
|---|---|---|
| PTT-01 Uruchomienie timera | Must / MVP | T01, T02, T16 |
| PTT-02 Zatrzymanie timera | Must / MVP | T01, T02, T20 |
| PTT-03 Przełączenie na inne zadanie | Must / MVP | T02 |
| PTT-04 Globalny skrót start/stop | Must / MVP | T03 |
| PTT-06 Konfiguracja/konflikt skrótu | Must / MVP | T03 |
| PTT-07 Praca w tle i tray | Must / MVP | T04, T21 |
| PTT-08 Widoczny stan i kontekst pomiaru | Must / MVP | T01, T04 |
| PTT-09 Odzyskiwanie po awarii | Must / MVP | T05, T26 |
| PTT-10 Uśpienie komputera | Must / MVP | T06, T23 |
| PTT-11 Lokalni klienci | Must / MVP | T07, T16 |
| PTT-12 Projekty przypisane do klienta | Must / MVP | T07 |
| PTT-13 Zadania w projekcie | Must / MVP | T07 |
| PTT-14 Archiwizacja z historią | Must / MVP | T08, T09 |
| PTT-16 Historia pomiarów | Must / MVP | T09 |
| PTT-17 Ręczny wpis czasu | Must / MVP | T10 |
| PTT-18 Korekta i historia zmian | Must / MVP | T11, T26 |
| PTT-19 Nakładanie się przedziałów | Must / MVP | T10, T11 |
| PTT-20 Raport czasu klienta | Must / MVP | T12, T19, T24, T25 |
| PTT-22 CSV jednego klienta | Must / MVP | T13, T22, T25 |
| PTT-23 Podgląd przed CSV | Must / MVP | T13, T25 |
| PTT-25 Kopia i odtworzenie | Must / MVP | T14 |
| PTT-26 Ochrona danych/poświadczeń | Must / MVP | T15, R01, R02 |
| PTT-32 Pełne offline | Must / MVP | T16 |
| PTT-33 Pojedyncza instancja | Must / MVP | T17 |
| PTT-34 Zmiana zegara/strefy | Must / MVP | T18, T24 |
| PTT-35 Północ/granice raportu | Must / MVP | T19, T24, T25 |
| PTT-36 Błąd zapisu/brak miejsca | Must / MVP | T20, T26 |
| PTT-37 Jawne zakończenie podczas pomiaru | Must / MVP | T21 |
| PTT-38 Dokładność/format eksportu | Must / MVP | T13, T19, T25 |
| PTT-39 Bezpieczny tekst w eksporcie | Must / MVP | T22 |

**Wynik macierzy:** 30/30 pól Must MVP ma przypisany przynajmniej jeden scenariusz. To tylko pokrycie planem, NIE pokrycie wykonaniem. T01–T26 mają instrukcję poniżej, w tym T23–T26 weryfikujące skonsolidowane D11/D12. R01–R03 to dodatkowe bramki D11; nie utożsamiać ich z nowymi identyfikatorami PTT.

## 3. Procedury szczegółowe T01–T26 (wszystkie: NOT RUN)

**T01 — start/stop i stan timera (PTT-01/02/08).** Dane: K-A / Wspólny / A1, zegar Windows bez modyfikacji. Kroki: uruchom aplikację offline; wybierz K-A, projekt i zadanie; naciśnij Start; odczekaj co najmniej 5 s, sprawdź stan w głównym oknie; Stop; zamknij i uruchom ponownie. Oczekiwane: dokładnie jeden zamknięty wpis K-A, czas nieujemny odpowiada rzeczywiście upływającemu czasowi, stan „zatrzymany”, ta sama historia po restarcie; brak drugiego bieżącego pomiaru.

**T02 — atomowe przełączanie A→B i retry (PTT-01/02/03).** Dane: aktywne A1 i istniejące A2; nieistniejący taskId 999999. Kroki: Start A1; wybierz Start A2; sprawdź wpisy; powtórz ten sam Start; spróbuj przełączyć na nieistniejący/archiwalny cel; w osobnym teście wywołaj wymuszony błąd transakcji SQLite. Oczekiwane: koniec A1 = początek A2 (jedna granica czasowa), tylko jeden aktywny timer; powtórzenie nie tworzy duplikatu; błędne żądanie zachowuje A2 i wycofuje wszystkie zmiany.

**T03 — globalny skrót i konflikt (PTT-04/06).** Dane: wybrany kontekst K-A/A1, drugie okno aplikacji, inny program zajmujący skrót. Kroki: przypisz dopuszczalny skrót, aktywuj inny program, wywołaj Start/Stop; uruchom konfliktujący skrót i spróbuj zapisać konfigurację; uruchom ponownie aplikację. Oczekiwane: skrót działa globalnie tylko w przypisanym kontekście, nie uruchamia dwóch timerów; konflikt jest czytelnie sygnalizowany, bez przejęcia zajętej kombinacji; ustawienie utrzymuje się zgodnie z decyzją. Fizyczny USB PTT-05 (Should) testować osobno, nie jest bramką MVP.

**T04 — zamknięcie okna, tray, powrót (PTT-07/08/37).** Dane: aktywne A1. Kroki: zamknij główne okno przy działającym timerze; otwórz je przez tray; sprawdź widget i ponownie otwórz główne okno; spróbuj jawnie zakończyć proces z timera. Oczekiwane: zamknięcie okna nie gubi stanu; tray przywraca ten sam wpis; jawne zakończenie ma poprawny dialog, nie zamraża okien i nie gubi danych.

**T05 — crash/restart/recovery (PTT-09).** Dane: A1 pracujący 1–2 min, plik SQLite w profilu VM. Kroki: zakończ proces wymuszeniem bez Stop; uruchom ponownie, odczytaj listę nierozstrzygniętych pomiarów/szkiców; anuluj próbę rozstrzygnięcia, a następnie świadomie rozstrzygnij i uruchom ponownie. Oczekiwane: brak automatycznego dopisywania niezweryfikowanego czasu; użytkownik widzi stan wymagający decyzji; anulowanie nie usuwa szkicu; poprawne potwierdzenie tworzy co najwyżej jeden poprawny wpis i zachowuje ślad audytowy.

**T06 — rzeczywiste uśpienie i powrót (PTT-10).** Dane: timer A1, odczyty licznika czasu przed i po sleep. Kroki: włącz pomiar, uśp Windows w VM/laptopie; wybudź po kilku minutach; obejrzyj pomiar i raport/CSV przed rozstrzygnięciem; świadomie zaakceptuj lub odrzuć czas snu, sprawdź sumy. Oczekiwane: uśpienie jest jawnie oznaczone; niezaakceptowany czas nie zwiększa potwierdzonego czasu pracy ani finalnego CSV; akceptacja/odrzucenie jest jednokrotne i audytowalne. Rejestrować ograniczenia krótkiego snu/zmiany liczników. **Krótkie uśpienie (D4, decyzja PO 23.11.2026, schemat v14):** sen krótszy niż 5 min (wybudzenie − uśpienie < 300 000 ms, stała `SHORT_SLEEP_AUTO_INCLUDE_MS`) jest wliczany do pomiaru bez pytania: bez banera i listy „Uśpienie do rozstrzygnięcia”, bez stanu „Do weryfikacji”, zapis `decision='auto_included'` z `decided_ms` równym czasowi wybudzenia. Sen od 5 min wzwyż (granica włącznie) i każdy niezakończony okres: bez zmian według D4-A (pytanie, brak w CSV do decyzji). Wykonać dwa przebiegi: krótki (1–2 min) — czas wliczony w licznik, raport i CSV, brak pytania; długi (≥ 5 min) — pytanie jak wyżej. Granice 299 999 / 300 000 ms i 1 s są w testach Rust; E2E Windows (`short-sleep`) sprawdza zapis aplikacji na danych syntetycznych, nie fizyczny suspend.

**T07 — CRUD i izolacja danych (PTT-11/12/13).** Dane: K-A i K-B, w obu projekt „Wspólny”, zadania A1 i B1. Kroki: offline utwórz obie hierarchie; dodaj wpisy; spróbuj przypisać zadanie B1 do projektu K-A i sprawdzić obcy projectId; zmień nazwę jednej pozycji; restart. Oczekiwane: ID i relacje trwałe, brak cichego przenoszenia historii, nieistniejący lub obcy identyfikator jest odrzucony bez częściowego zapisu.

**T08 — archiwum klienta/projektu/zadania (PTT-14).** Dane: K-A z dwoma projektami, jeden z aktywnym timerem. Kroki: spróbuj archiwizować aktywny cel; zatrzymaj timer, archiwizuj projekt i klienta; przywróć tylko klienta, następnie jeden projekt, następnie zadanie. Oczekiwane: brak archiwizacji w trakcie aktywnego pomiaru, brak kaskadowego odarchiwizowania projektów po przywróceniu klienta, wpisy historyczne zachowane i dostępne w raportach, archiwalne pozycje nie są oferowane dla nowego Start.

**T09 — historia i trwałość (PTT-14/16).** Dane: A1/A2 i B1, co najmniej trzy zakończone wpisy. Kroki: wyświetl historię z datą/klientem/projektem/zadaniem; restart, archiwizuj zadanie, ponownie wyświetl historię. Oczekiwane: te same ID, zakresy i klient; archiwizacja nie usuwa historii.

**T10 — ręczne wpisy i overlap (PTT-17/19).** Dane: A1 09:00–10:00, drugi wpis 09:30–10:30, trzeci 10:00–11:00 i powtórzona godzina DST. Kroki: dodaj pierwszy; spróbuj nałożenia; dodaj stykający się; próbuj nieistniejącej/powtórzonej lokalnej godziny bez rozstrzygnięcia. Oczekiwane: overlap odrzucony, stykanie zaakceptowane, DST nie jest przeliczany zgadywaniem, poprzedni wpis niezmieniony.

**T11 — korekta i audyt (PTT-18/19).** Dane: A1 09:00–10:00, A2 11:00–12:00. Kroki: zmień A1 na 09:00–10:30; sprawdź historię wartości; spróbuj zmienić A1 na zakres kolidujący z A2; zasymuluj błąd zapisu. Oczekiwane: jedna udana atomowa korekta wraz z historią, nieudana korekta bez zmian i z zachowanymi wartościami. Usuwanie PTT-21 ma priorytet Should — jego regresję wykonać dodatkowo, nie zastępuje T11.

**T12 — raport klienta (PTT-20).** Dane: K-A = 2h w jednym dniu, K-B = 3h (również projekt nazwany „Wspólny”); jeden wpis usunięty, jeden aktywny, jeden pending. Kroki: filtr K-A, K-B i świadomy widok „wszyscy”; zmień okres i grupowanie; porównaj sumy z historią. Oczekiwane: K-A=2h, K-B=3h, razem 5h tylko gdy wybrano wszystkich; wpisy usunięte i niezatwierdzone nie zawyżają sum; filtr nie zmienia się sam po odświeżeniu.

**T13 — podgląd i eksport jednego klienta (PTT-22/23/38).** Dane: K-A i K-B, opisy z polskimi znakami, średnikiem, cudzysłowem i nową linią; wpis przekraczający 24h. Kroki: wybierz K-A i okres, przygotuj podgląd, porównaj ID/liczby/czasy; pobierz CSV po potwierdzeniu; otwórz w polskim Excelu i parserze CSV; próbuj odpowiedzi backendu z obcym klientem/duplikatem ID. Oczekiwane: UTF-8 BOM, separator `;`, quoting, pełne sekundy i HH:MM:SS bez modulo 24h, daty IANA; podgląd = źródło pliku, brak wpisów K-B i brak powtórzonych ID, niezgodność powoduje odmowę eksportu. Testy PR #3 są automatyczne; QA GUI pozostaje osobny.

**T14 — backup i restore (PTT-25).** Dane: dwaj klienci z historią, otwarty timer, WAL aktywny, niezależna testowa kopia SQLite. Kroki: wykonaj kopię przy aktywnym timerze, sprawdź integralność; zakończ timer; wskaż kopię, obejrzyj podgląd, anuluj, potem świadomie potwierdź; spróbuj przywrócić uszkodzoną/nowszą kopię. Oczekiwane: spójny snapshot bez brakujących wpisów, brak zmian produkcyjnej bazy przed potwierdzeniem; odmowa złej kopii bez utraty danych, kopia bezpieczeństwa przed podmianą, restart po restore, brak stale działań innych okien.

**T15 — ochrona lokalnych danych (PTT-26).** Dane: dwa osobne standardowe profile Windows; fikcyjne nazwy klientów i opisy. Kroki: zainstaluj/uruchom aplikację w profilu A, utwórz bazę i kopię; sprawdź ścieżkę i ACL, logi, pakiet/ZIP, uprawnienia dostępu profilu B; przeanalizuj politykę sekretów. Oczekiwane: brak produkcyjnych baz w repo/paczce, brak wycieku opisów/tokenów/sekretów do logów; baza w odpowiednim per-user AppData; profil B nie otrzymuje cudzej bazy. Backup nie jest domyślnie szyfrowany: odnotować ryzyko i wymagany poziom ochrony.

**T16 — pełny cykl offline (PTT-01/11/32).** Dane: obaj klienci, projekty i zadania, dzienny zestaw kilku pomiarów. Kroki: wyłącz internet przed startem; wykonaj lokalne CRUD, Start/Switch/Stop, historię, raport i CSV, restart; dopiero po teście przywróć internet. Oczekiwane: żadna kluczowa czynność MVP nie wymaga Notion/tokena ani połączenia; wszystkie ID i dane pozostają po restarcie, raport zgodny z zapisami.

**T17 — jedna instancja (PTT-33).** Dane: aktywne okno i timer K-A. Kroki: uruchom `tracker-master.exe` drugi raz w tym samym profilu; sprawdź liczbę procesów i otwarte SQLite; uruchom z drugiego standardowego profilu Windows. Oczekiwane: nie ma drugiego zapisu do tej samej bazy ani drugiego timera; pierwsza sesja pozostaje responsywna; profil B ma własną izolowaną bazę.

**T18 — zegar i strefa (PTT-34).** Dane: aktywny timer, strefa raportu Europe/Warsaw. Kroki: w VM przesuń zegar Windows w przód i wstecz, zmień strefę systemową; wróć do poprawnej daty i restart. Oczekiwane: brak ujemnego/zawyżonego czasu akceptowanego milcząco; niepewność wymaga ręcznego rozstrzygnięcia; strefa raportu nie zmienia się wskutek samej zmiany strefy komputera.

**T19 — północ, DST i precyzja (PTT-20/35/38).** Dane: wpis 23:50–00:10 przez granicę dnia; dni 29.03.2026 (23h) i 25.10.2026 (25h) w Europe/Warsaw; wpis >24h. Kroki: porównaj przypisanie sekund do lokalnych dat, raport miesięczny, podgląd CSV i sumę z pełnego wpisu. Oczekiwane: żadna sekunda nie jest podwójnie liczona; pełen przedział ma sumę części; DST liczone z faktycznego czasu, nie przez stałe 86400 s na dzień; CSV zgodne z raportem w wybranym okresie.

**T20 — błąd SQLite / brak miejsca (PTT-02/36).** Dane: aktywny timer A1, kopia bazy testowej. Kroki: w VM ustaw bazę read-only lub zasymuluj brak miejsca; spróbuj Stop/Switch/korekty; przywróć możliwość zapisu i powtórz operację. Oczekiwane: żadnego fałszywego „Zapisano”; brak utraty/duplikacji wpisów, transakcja atomowa, jednoznaczny komunikat i bezpieczne ponowienie.

**T21 — świadome zakończenie (PTT-07/37).** Dane: aktywny A1; otwarte główne okno i widget. Kroki: w tray wybierz „Zakończ aplikację”, odmów lub anuluj, a następnie zatrzymaj pomiar i zakończ; uruchom ponownie. Oczekiwane: po anulowaniu aplikacja odpowiada i timer nadal działa; po świadomym zakończeniu zapis i historia są poprawne, żadna ścieżka dialogu nie zawiesza aplikacji.

**T22 — CSV injection i polskie znaki (PTT-22/39).** Dane: nazwy i opisy rozpoczynające się `=`, `+`, `-`, `@`, tabulatorem/nową linią; `Zażółć gęślą jaźń`, `"test";` i wielowierszowy opis. Kroki: podgląd, eksport CSV, otwórz w arkuszu i zweryfikuj cytowanie; ponownie odczytaj oryginalny wpis w SQLite. Oczekiwane: żaden tekst użytkownika nie jest wykonany jako formuła, polskie znaki i nowe linie zachowane, eksport nie modyfikuje opisu źródłowego.


**T23 — wiele okresów uśpienia i decyzje po restarcie (PTT-09/10/20).** Dane syntetyczne: A1, 10:00–11:00 praca, S1 sen 11:00–12:00, praca 12:00–12:30, S2 sen 12:30–13:00, praca 13:00–14:00. Osobny przypadek: brak czasu wybudzenia. Kroki: rzeczywisty suspend/resume Windows 11 x64, identyfikacja S1/S2, odłożenie decyzji „Później”, restart, odczyt listy i banera 10 sekund, wpisanie brakującej godziny (gdy potrzeba), doliczenie wyłącznie S1, odrzucenie S2, ponowne wykonanie tej samej operacji i kolejne restarty. Oczekiwane: 2h30m pracy + 1h30m pending przed decyzją; po doliczeniu S1 — 3h30m pracy; po odrzuceniu S2 — nadal 3h30m; brak automatycznego dopisywania, podwójnego naliczenia i nadpisania granic (S1 i S2 trwają ≥ 5 min, więc reguła krótkiego uśpienia ich nie dotyczy). Dodatkowy przypadek D4 (schemat v14): S3 — krótki sen 2 min w pracy 13:00–14:00 — wliczony automatycznie, nie pojawia się na liście ani w banerze; sumy przed i po decyzjach bez zmian (2h30m pracy + 1h30m pending, potem 3h30m), bez podwójnego naliczenia S3. UI nie blokuje timera przy odroczeniu, a okres z nieznanym końcem wymaga jawnej korekty; Summary/Detailed/CSV zgodne ze stanem decyzji.

**T24 — strefa IANA, filtr dat, presety i DST (PTT-20/34/35).** Dane: źródło UTC 2026-01-31 23:30–2026-02-01 00:30 (3600 s), filtr styczniowy oraz instant referencyjny 2026-11-15 23:30Z. Kroki: wyświetl Europe/Warsaw, wybierz Europe/London i „Anuluj”, następnie „Zastosuj”; powtórz z błędem trwałego zapisu ustawienia i dla presetów „Dzisiaj”/„Ten tydzień”; sprawdź restart, powrót do Warszawy oraz daty DST. Oczekiwane: w Warszawie styczeń 0 s, luty 3600 s; w Londynie styczeń 1800 s, luty 1800 s, bez zmiany całkowitego czasu i entryId; anulowanie/błąd persist niczego nie zapisują; ręcznie wskazane daty filtra pozostają takie same, presety względne przeliczają lokalny dzień (Warszawa 16.11, Londyn 15.11); eksport i Detailed pokazują te same wkłady.

**T25 — finalny kontrakt 12 kolumn CSV (PTT-20/22/23/35/38/39).** Dane: ukończony wpis 23:30–01:30 przez północ (7200 s), dwóch klientów A/B, rozliczalne i nierozliczalne wpisy, tekst z polskimi znakami, średnikiem, cudzysłowem, nową linią oraz potencjalną formułą; czas ponad 24 h. Kroki: wygeneruj podgląd Detailed i CSV dla pojedynczego dnia, całego okresu i każdego klienta; porównaj zapisane bajty oraz widok polskiego Excela, przetestuj Europe/Warsaw i DST. Oczekiwane: dokładnie 12 zatwierdzonych polskich kolumn w kolejności: ID, klient, projekt, zadanie, opis, start, koniec, rozliczalność, całkowite sekundy, całkowite HH:MM:SS, sekundy w okresie, HH:MM:SS w okresie; 1 wiersz na oryginalny ukończony wpis; UTF-8 z pojedynczym BOM, separator średnik, cytowanie i ochrona przed CSV injection, wartości Tak/Nie, lokalne ISO8601 z offsetem, bez zaokrągleń, brak zawijania czasu po 24h. Dla pełnego wpisu 7200 s, a dla odpowiednich dni wkład 1800 s i 5400 s; bez obcych klientów, aktywnych i nierozstrzygniętych sekund w sumach. Zawartość CSV zgodna z podglądem, bez zmian w bazie źródłowej.

**T26 — szkice po awarii i preferencje sortowania (PTT-09/18/36).** Dane: formularz edycji E1, lokalny szkic, później zmodyfikowany bądź usunięty oryginał oraz dwa oczekujące szkice. Kroki: zmień formularz, odczekaj około 1 s bez wpisywania i wywołaj blur, wymuś zamknięcie procesu i restart; odłóż powiadomienie do końca sesji, sprawdź listę „Szkice (N)”, konflikt wersji E1, brak oryginału i ręczne odtworzenie nowego wpisu ze śladem pochodzenia; wybierz „Najnowsze/Najstarsze”, wykonaj restart, zasymuluj błąd persist, automatyczne ograniczone ponowienia i ręczne „Spróbuj ponownie”. Oczekiwane: szkice zachowane bez automatycznego usunięcia i bez cichego nadpisania oryginału, trwały audyt pochodzenia, poprawny porządek i zapamiętanie preferencji; przy błędzie zapisu preferencja działa w bieżącej sesji z ostrzeżeniem, a ręczne retry nie resetuje limitu automatycznych prób. Scenariusz początkowo NOT RUN.

## 4. Dodatkowe bramki D11 wydania Store (NOT RUN)

**R01 — prawdziwe MSIX i Private audience.** Dane: konto MSA właściciela (bez wpisywania adresu do dowodów), drugie niezaproszone MSA, czysty Windows 11 x64. Kroki: zweryfikuj zatwierdzony pakiet w Store, pozytywny pobór przez właściciela, negatywna próba obcego konta także z bezpośrednim linkiem. Oczekiwane: produkt Free, prywatna grupa tylko z MSA właściciela, brak nieautoryzowanego pobrania, nie rozszerzano grona testerów. Nie tworzyć konta/nie publikować bez osobnej operacyjnej autoryzacji.

**R02 — trwałość po uninstall/reinstall MSIX.** Dane: K-A/K-B, ID, wpisy, korekty, backupy, ustawienia, zapisane hashe. Kroki: na rzeczywistym podpisanym pakiecie utwórz dane, aktualizuj wersję, odinstaluj normalnie, ponownie zainstaluj w tym samym profilu; sprawdź zarówno bazę główną, jak i WAL/SHM, ID i ustawienia. Oczekiwane: dedykowany **niewirtualizowany per-user AppData** zgodnie z ostatnią decyzją D11; żadnego wyzerowania danych po normalnym uninstall; migracje zachowują wszystkie relacje i historię. Nie domniemywać tego z działania Tauri `app_data_dir` ani testu debug EXE.

**R03 — podpis i reputacja / aktualizacja.** Dane: finalny Store MSIX, hash artefaktu, wersje N i N+1, Windows 11 x64 z aktywnymi zabezpieczeniami. Kroki: zweryfikuj tożsamość/podpis Store, instalację i uruchomienie, upgrade z wpisami klientów; sprawdź zdarzenia ochrony Windows. Oczekiwane: prawidłowa sygnatura i działające uruchomienie bez wyłączenia Smart App Control; brak utraty czasu i danych po upgrade; brak sekretów/poufnych danych w artefaktach. Sam zielony `cargo test` lub `tauri build --no-bundle` = niewystarczający dowód.

## 5. Minimalny zapis wyniku (dla każdego Txx / Rxx)

| Pole | Wymagane |
|---|---|
| Test ID / wymagania | Np. `T14 / PTT-25` |
| Wykonawca i niezależny recenzent | Identyfikator, nie tajne dane konta |
| Commit / tag / SHA-256 pakietu | Konkretna testowana wersja |
| Środowisko | Windows 11 build, x64, tryb ochrony, profil, MSIX |
| Dane fikcyjne | ID klienta/projektu/wpisu i okres, bez realnych danych |
| Kroki, actual vs expected | Wypełnione podczas wykonania |
| Wynik | PASS / FAIL / BLOCKED / NOT RUN |
| Dowody | Link do logu/zdjęcia/raportu, bez sekretów |
| Defekt / ponowienie | ID zgłoszenia, data poprawki i ponowny wynik |

**Brama DEV-15:** wszystkie 30 pozycji Must muszą mieć wykonane testy, łącznie z nowymi T23–T26, bez krytycznych FAIL/BLOCKED, a scenariusze T05/T06/T13/T14/T15/T16/T20 oraz R01–R03 muszą być poparte dowodami odpowiednio do bieżącej D11. Wymaganie „niezależna QA” w QA-01 jest osobne — autor kodu nie zatwierdza samodzielnie wydania. Brak podpisanego/instalowalnego MSIX, testu realnego sleep, migracji, braku mieszania klientów lub przywracania = **BLOCKED**, a nie PASS.

## 6. Otwarte uzgodnienia i kontrola aktualności

- **D11 i D12 zatwierdzono biznesowo 17.11.2026** (Status Zrobione, Akceptacja Zatwierdzone). D11: Windows 11 x64, Microsoft Store MSIX Private audience, konto Individual i jedyne osobiste MSA właściciela, trwałe niewirtualizowane per-user AppData po uninstall/reinstall. Poprzednie NSIS/OneDrive/płatne podpisywanie to historie propozycji, nie obowiązujący kanał wydania. D12: UTC/IANA/DST, indywidualne pending, nieblokujące przypomnienia, Detailed/CSV i odzyskiwane szkice. Obie decyzje nie wymagają ponownego głosowania PO.
- Akceptacja D11/D12 nie oznacza odbioru żadnego DEV ani wykonania testów. Wiele kart PTT ma nadal Akceptacja=Propozycja. TECH-06 ocenia kompletność *planu*; QA-01/DEV-15 oceniają rzeczywiście uruchomione testy i pozostają osobne.
- Przy nowym Must zmienić macierz, dodać scenariusz i ponownie zrewidować bramkę; nie zaliczać pokrycia testem, który nie spełnia nowego kontraktu.
- Pokrycie scenariuszami = plan. Pokrycie wdrożeniem = osobny przegląd GitHub. Pokrycie wykonaniem = zarejestrowany wynik QA. Te trzy poziomy raportować oddzielnie.

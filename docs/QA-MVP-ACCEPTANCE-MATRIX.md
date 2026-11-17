# TECH-06 — Macierz testów i odbioru MVP TrackerMaster

**Data opracowania:** 2026-11-17  
**Źródła:** Notion „Backlog — Personal Time Tracker”: PTT-01–PTT-41, TECH-06, DEV-15, QA-01 oraz decyzje D1–D12; GitHub `main` bazowo `d9f70423d9cb2ffff0ed22d6308fb08c7da3de8c`.  
**Status dokumentu:** PLAN DO NIEZALEŻNEGO REVIEW. Wszystkie wyniki wykonania niżej są **NOT RUN** — ten dokument nie jest protokołem przetestowania instalatora.  
**Kryterium pokrycia:** 30 wymaganych w backlogu pozycji oznaczonych *MVP + Must* (PTT-05 i PTT-21 mają priorytet Should, więc nie są bramką Must). „Must” to priorytet wpisu, nie dowód zatwierdzonej akceptacji — właściwość `Akceptacja` wymaga odrębnego rozstrzygnięcia.

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
| PTT-09 Odzyskiwanie po awarii | Must / MVP | T05 |
| PTT-10 Uśpienie komputera | Must / MVP | T06 |
| PTT-11 Lokalni klienci | Must / MVP | T07, T16 |
| PTT-12 Projekty przypisane do klienta | Must / MVP | T07 |
| PTT-13 Zadania w projekcie | Must / MVP | T07 |
| PTT-14 Archiwizacja z historią | Must / MVP | T08, T09 |
| PTT-16 Historia pomiarów | Must / MVP | T09 |
| PTT-17 Ręczny wpis czasu | Must / MVP | T10 |
| PTT-18 Korekta i historia zmian | Must / MVP | T11 |
| PTT-19 Nakładanie się przedziałów | Must / MVP | T10, T11 |
| PTT-20 Raport czasu klienta | Must / MVP | T12, T19 |
| PTT-22 CSV jednego klienta | Must / MVP | T13, T22 |
| PTT-23 Podgląd przed CSV | Must / MVP | T13 |
| PTT-25 Kopia i odtworzenie | Must / MVP | T14 |
| PTT-26 Ochrona danych/poświadczeń | Must / MVP | T15, R01, R02 |
| PTT-32 Pełne offline | Must / MVP | T16 |
| PTT-33 Pojedyncza instancja | Must / MVP | T17 |
| PTT-34 Zmiana zegara/strefy | Must / MVP | T18 |
| PTT-35 Północ/granice raportu | Must / MVP | T19 |
| PTT-36 Błąd zapisu/brak miejsca | Must / MVP | T20 |
| PTT-37 Jawne zakończenie podczas pomiaru | Must / MVP | T21 |
| PTT-38 Dokładność/format eksportu | Must / MVP | T13, T19 |
| PTT-39 Bezpieczny tekst w eksporcie | Must / MVP | T22 |

**Wynik macierzy:** 30/30 pól Must MVP ma przypisany przynajmniej jeden scenariusz. To tylko pokrycie planem, NIE pokrycie wykonaniem. T01–T22 mają instrukcję poniżej. R01–R03 to dodatkowe bramki D11; nie utożsamiać ich z nowymi identyfikatorami PTT.

## 3. Procedury szczegółowe (wszystkie: NOT RUN)

**T01 — start/stop i stan timera (PTT-01/02/08).** Dane: K-A / Wspólny / A1, zegar Windows bez modyfikacji. Kroki: uruchom aplikację offline; wybierz K-A, projekt i zadanie; naciśnij Start; odczekaj co najmniej 5 s, sprawdź stan w głównym oknie; Stop; zamknij i uruchom ponownie. Oczekiwane: dokładnie jeden zamknięty wpis K-A, czas nieujemny odpowiada rzeczywiście upływającemu czasowi, stan „zatrzymany”, ta sama historia po restarcie; brak drugiego bieżącego pomiaru.

**T02 — atomowe przełączanie A→B i retry (PTT-01/02/03).** Dane: aktywne A1 i istniejące A2; nieistniejący taskId 999999. Kroki: Start A1; wybierz Start A2; sprawdź wpisy; powtórz ten sam Start; spróbuj przełączyć na nieistniejący/archiwalny cel; w osobnym teście wywołaj wymuszony błąd transakcji SQLite. Oczekiwane: koniec A1 = początek A2 (jedna granica czasowa), tylko jeden aktywny timer; powtórzenie nie tworzy duplikatu; błędne żądanie zachowuje A2 i wycofuje wszystkie zmiany.

**T03 — globalny skrót i konflikt (PTT-04/06).** Dane: wybrany kontekst K-A/A1, drugie okno aplikacji, inny program zajmujący skrót. Kroki: przypisz dopuszczalny skrót, aktywuj inny program, wywołaj Start/Stop; uruchom konfliktujący skrót i spróbuj zapisać konfigurację; uruchom ponownie aplikację. Oczekiwane: skrót działa globalnie tylko w przypisanym kontekście, nie uruchamia dwóch timerów; konflikt jest czytelnie sygnalizowany, bez przejęcia zajętej kombinacji; ustawienie utrzymuje się zgodnie z decyzją. Fizyczny USB PTT-05 (Should) testować osobno, nie jest bramką MVP.

**T04 — zamknięcie okna, tray, powrót (PTT-07/08/37).** Dane: aktywne A1. Kroki: zamknij główne okno przy działającym timerze; otwórz je przez tray; sprawdź widget i ponownie otwórz główne okno; spróbuj jawnie zakończyć proces z timera. Oczekiwane: zamknięcie okna nie gubi stanu; tray przywraca ten sam wpis; jawne zakończenie ma poprawny dialog, nie zamraża okien i nie gubi danych.

**T05 — crash/restart/recovery (PTT-09).** Dane: A1 pracujący 1–2 min, plik SQLite w profilu VM. Kroki: zakończ proces wymuszeniem bez Stop; uruchom ponownie, odczytaj listę nierozstrzygniętych pomiarów/szkiców; anuluj próbę rozstrzygnięcia, a następnie świadomie rozstrzygnij i uruchom ponownie. Oczekiwane: brak automatycznego dopisywania niezweryfikowanego czasu; użytkownik widzi stan wymagający decyzji; anulowanie nie usuwa szkicu; poprawne potwierdzenie tworzy co najwyżej jeden poprawny wpis i zachowuje ślad audytowy.

**T06 — rzeczywiste uśpienie i powrót (PTT-10).** Dane: timer A1, odczyty licznika czasu przed i po sleep. Kroki: włącz pomiar, uśp Windows w VM/laptopie; wybudź po kilku minutach; obejrzyj pomiar i raport/CSV przed rozstrzygnięciem; świadomie zaakceptuj lub odrzuć czas snu, sprawdź sumy. Oczekiwane: uśpienie jest jawnie oznaczone; niezaakceptowany czas nie zwiększa potwierdzonego czasu pracy ani finalnego CSV; akceptacja/odrzucenie jest jednokrotne i audytowalne. Rejestrować ograniczenia krótkiego snu/zmiany liczników.

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

**Brama DEV-15:** wszystkie 30 pozycji Must muszą mieć wykonane testy, bez krytycznych FAIL/BLOCKED, a scenariusze T05/T06/T13/T14/T15/T16/T20 oraz R01–R03 muszą być poparte dowodami odpowiednio do bieżącej D11. Wymaganie „niezależna QA” w QA-01 jest osobne — autor kodu nie zatwierdza samodzielnie wydania. Brak podpisanego/instalowalnego MSIX, testu realnego sleep, migracji, braku mieszania klientów lub przywracania = **BLOCKED**, a nie PASS.

## 6. Otwarte uzgodnienia i kontrola aktualności

- D11 i D12 mają nadal zbiorczy status „Do decyzji”; w ich treści znajdują się liczne zatwierdzone poddecyzje. Przed wykonaniem QA potwierdzić ostatnią wersję kontraktu (nowsze poddecyzje mogą nadpisywać wcześniejsze zapisy, np. NSIS→Store MSIX).
- Właściwość `Akceptacja` wymaga osobnego zatwierdzenia; ten plan nie zmienia jej automatycznie.
- Przy nowym Must zmienić macierz, dodać scenariusz i ponownie zrewidować bramkę; nie zaliczać pokrycia testem, który nie spełnia nowego kontraktu.
- Pokrycie scenariuszami = plan. Pokrycie wdrożeniem = osobny przegląd GitHub. Pokrycie wykonaniem = zarejestrowany wynik QA. Te trzy poziomy raportować oddzielnie.

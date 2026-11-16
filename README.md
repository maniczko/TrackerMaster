# Personal Time Tracker — prototyp 0.1.0

Lokalna aplikacja Windows zbudowana w Tauri 2, React, TypeScript i SQLite. To prototyp: nie należy jeszcze używać go do rzeczywistych danych klientów ani rozliczania czasu.

Można utworzyć klienta, projekt i zadanie, uruchomić lub zatrzymać jeden pomiar oraz obejrzeć historię. Dodano archiwizowanie i przywracanie projektów; podstawowy scenariusz sprawdzono na danych testowych w Windows Sandbox. Po ponownym uruchomieniu przerwany pomiar wymaga ręcznego wskazania końca; wskazany przedział obejmuje również ewentualne przerwy.

## Przygotowanie w Windows

Potrzebne są Node.js z npm, Rust z Cargo, Microsoft C++ Build Tools z Windows SDK oraz WebView2 Runtime, zgodnie z wymaganiami Tauri 2. Vite wymaga Node.js 20.19 lub nowszego w serii 20 albo co najmniej 22.12. Dotychczas użyto Node.js 24.20.0 oraz Rust/Cargo 1.100.0. W katalogu głównym projektu wykonaj:

```powershell
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

`npm ci` korzysta z `package-lock.json`; Cargo korzysta z `src-tauri/Cargo.lock`. `npm run build` sprawdza i buduje interfejs, a `cargo test` uruchamia testy backendu. Polecenie `npm run tauri dev` buduje i otwiera aplikację deweloperską.

Do przygotowania pakietu instalacyjnego służy `npm run tauri build`. Samo wykonanie tego polecenia nie potwierdza poprawnej instalacji, aktualizacji ani odtwarzania danych. Te scenariusze wymagają jeszcze sprawdzenia na czystym Windows.

## Aktualny stan weryfikacji

Budowanie interfejsu i kompilacja backendu zakończyły się powodzeniem na komputerze deweloperskim. Wcześniejszy zestaw 20 testów Rust przeszedł w Windows Sandbox, w tym testy migracji, archiwizacji, rozbieżności zegara, symulowanej przerwy systemowej oraz błędu zapisu i ponowienia operacji. Dodane później kontrole schematu i blokady drugiej kopii skompilowano, ale ich testów jeszcze nie uruchomiono. Test z tymczasowym plikiem bazy potwierdził zachowanie historii i archiwum po migracji i ponownym otwarciu. W poprzedniej wersji debug w Windows Sandbox sprawdzono dodawanie klienta, projektu i zadania, pomiar, archiwizację, odzyskiwanie po zamknięciu oraz wymuszonym zakończeniu procesu i zachowanie wpisów po ponownym uruchomieniu. Po zamknięciu aplikacji z aktywnym pomiarem i ponownym otwarciu sprawdzono komunikat oraz status „Do weryfikacji”. Nie sprawdzono rzeczywistego uśpienia komputera, pełnego zestawu scenariuszy awaryjnych ani instalatora.

Na tym komputerze kontrola aplikacji Windows zablokowała uruchamianie części nowo zbudowanych, niepodpisanych plików (błąd 4551). Weryfikacja w izolowanym środowisku jest w toku. Nie wyłączaj ochrony systemu w celu uruchomienia prototypu; dystrybucja wymaga rozwiązania kwestii podpisu lub reputacji aplikacji.

Obsługa uśpienia, pełne odzyskiwanie po awarii, kopie, eksport, instalator i aktualizacje nie są ukończone lub zweryfikowane. Po aktualizacji narzędzi interfejsu audyt npm z 15.11.2026 nie zgłosił podatności; kompilacja interfejsu oraz opisany wyżej podstawowy test wersji debug przeszły.

W aktualnym kodzie sprawdzenie różnicy liczników systemu następuje przy zatrzymaniu lub zmianie zadania. Przy rozbieżności przekraczającej 2 sekundy otwarty pomiar wymaga ręcznej weryfikacji; krótsze przerwy mogą nie zostać wykryte. Ręcznie wskazany przedział nadal obejmuje ewentualne przerwy i nie zastępuje podziału pomiaru na okresy pracy i uśpienia.

Nowy kod próbuje zablokować równoczesne uruchomienie kilku kopii korzystających z tej samej bazy. Nie sprawdzono jeszcze tego w działającej aplikacji; starsze wersje prototypu nie stosują tej blokady. Przy błędzie odczytu aktualny interfejs blokuje operacje i umożliwia ponowienie odczytu. Ten scenariusz sprawdzono z symulowanym zapleczem, przed ostatnią zmianą wyglądu stanu błędu.

Katalog `spike/` zawiera oddzielny model eksperymentalny. Jego testy nie zastępują testów backendu Rust ani testów aplikacji.

Aktualizacja 15.11.2026: W Windows Sandbox zestaw 24 testów Rust zakończył się powodzeniem. Sprawdzono również dwa uruchomienia wersji debug na fikcyjnych danych: druga kopia pokazuje ostrzeżenie, bez dodatkowego okna z błędem. Nie przywraca jednak pierwszego okna; ikona w zasobniku i reguły zamykania nadal wymagają implementacji. Rzeczywiste uśpienie komputera i instalator nie zostały zweryfikowane.

Widget (prototyp): przycisk „Otwórz widget” otwiera małe okno współdzielące pomiar z aplikacją. Można wybrać zadanie, rozpocząć i zatrzymać pomiar, przypiąć okno oraz wrócić do głównego okna. W Windows Sandbox sprawdzono uruchomienie, przycisk start/stop, odświeżanie stanu w głównym oknie i lokalny skrót Ctrl+Shift+Spacja. Skrót działa tylko gdy widget jest aktywny; globalne, konfigurowalne skróty i wykrywanie konfliktów pozostają do wykonania. Widget zapamiętuje położenie oraz przypięcie; jeżeli zapisane położenie nie znajduje się na podłączonym ekranie, otwiera się w pozycji domyślnej. W Windows Sandbox sprawdzono odtworzenie położenia i przypięcia po zamknięciu i ponownym otwarciu widgetu oraz ponowne otwarcie zamkniętego głównego okna z widgetu. Nie sprawdzono jeszcze przywrócenia po zamknięciu całej aplikacji ani przy zmianie monitorów.

## Aktualizacja 16.11.2026

Powyższe wpisy opisują stan w chwili ich zapisania. W nowszej wersji debug w Windows Sandbox sprawdzono globalny skrót Ctrl+Shift+Spacja przy aktywnym oknie innej aplikacji oraz przywrócenie głównego okna za pomocą ikony w zasobniku po zamknięciu okien TrackerMaster. Skrót nadal nie jest konfigurowalny. Od tego testu zmieniono kolory interfejsu; te zmiany nie znajdują się w przetestowanej wersji debug.

W tej wersji debug wybranie „Zakończ aplikację” z ikony w zasobniku podczas aktywnego pomiaru wyświetliło ostrzeżenie, ale aplikacja przestała odpowiadać. Poprawka przenosi wyświetlenie ostrzeżenia poza wątek interfejsu i zwalnia wcześniej blokadę danych. Nie została jeszcze skompilowana ani przetestowana: kontrola aplikacji Windows blokuje na tym komputerze uruchamianie niektórych narzędzi i plików budowania (błąd 4551). Nie należy uznawać tego błędu za naprawiony w dostępnej wersji aplikacji.

Po przygotowaniu nowej wersji należy sprawdzić na fikcyjnych danych:

1. Uruchomić pomiar, wybrać „Zakończ aplikację”, zamknąć ostrzeżenie i upewnić się, że oba okna nadal odpowiadają, a pomiar można zatrzymać.
2. Zatrzymać pomiar, wybrać „Zakończ aplikację”, uruchomić ją ponownie i sprawdzić zapisany wpis.
3. Ponownie sprawdzić skrót globalny, przywracanie okna z zasobnika i wygląd widgetu; uruchomić testy backendu oraz pełną kompilację.

Istniejącej Piaskownicy nie należy zamykać bez uprzedniego zabezpieczenia potrzebnych danych: jej zamknięcie usuwa dane zapisane w tym środowisku.


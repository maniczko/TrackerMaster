# TrackerMaster — lokalny rejestr czasu pracy (prototyp 0.1.0)

Aplikacja Windows do rejestracji czasu według klientów, projektów i opcjonalnych zadań. Stos: **Tauri 2, React, TypeScript, Rust, SQLite**. Dane pomiarowe pozostają lokalnie; aplikacja działa bez Internetu i Notion.

> **Nie jest to wydanie produkcyjne.** Automatyczne testy Windows CI nie zastępują niezależnego odbioru na Windows 11 x64, podpisanego pakietu MSIX i formalnego zamknięcia QA-01. Do czasu odbioru pracuj wyłącznie na danych syntetycznych; nie rozliczaj na tym prototypie realnych klientów.

## Najpierw sprawdź bieżący stan

- [Stan implementacji i dowody na 23.11.2026](docs/PROJECT-STATUS.md) — punkt odniesienia, **migawka**, aktualizowana tylko po weryfikacji GitHub/Notion.
- [Zasady pracy, statusów i eskalacji](docs/WORKFLOW-GOVERNANCE.md) — kto i na jakich dowodach może zamykać zadania, PR i QA.
- [Macierz odbioru MVP](docs/QA-MVP-ACCEPTANCE-MATRIX.md) — kryteria i dowody; `NOT RUN` nie jest `PASS`.
- [Kontrakt czasu](docs/TECH-09-TIME-SEGMENTATION-CONTRACT.md) i [kontrakt raportu/CSV](docs/TECH-10-REPORT-CONTRACT.md).
- [Weryfikacja mini-timera](docs/MINI-TIMER-QA.md) i [podgląd UI](docs/PREVIEW-UI.md).
- [GitHub Actions](.github/workflows/windows-build.yml) — aktualne testy i kroki CI.

## Obowiązujące ustalenia produktu

| Obszar | Zakres MVP / późniejsze etapy |
| --- | --- |
| System | Windows **11 x64**, instalacja dla jednego użytkownika, SQLite w profilu użytkownika |
| Dystrybucja | Decyzja D11: **MSIX poprzez Microsoft Store, private audience**. Wymaga osobnej zgody na operacje w Store i niezależnej weryfikacji. Starsze opisy NSIS/OneDrive to historia, nie bieżąca bramka. |
| Podstawowe funkcje | Jeden aktywny timer, atomowe Start/Stop/Switch, klient i projekt wymagane, zadanie opcjonalne; historia/korekta, raport i CSV z izolacją klienta |
| Bezpieczeństwo danych | Transakcje i rollback, jawne rozstrzyganie niepewnych okresów, kopia i ręczne odtworzenie; zachowanie lokalnych danych przy odinstalowaniu |
| Integracja Notion | **Nie jest wymaganiem MVP.** D9: w V1.2 jednostronne pobieranie zadań; czas nie jest wysyłany do Notion. |
| UI i raporty | Styl Quiet Precision. Widoki kalendarza i rozszerzone raporty realizowane w V1.1, nie podnoszą wymagań MVP. |
| USB | Przycisk fizyczny opcjonalny; globalny konfigurowalny skrót jest wymagany w MVP. |

Źródło decyzji i backlogu: [Personal Time Tracker — backlog i decyzje (Notion)](https://app.notion.com/p/418e1de1f67a8152928dfe2ccb01db64). Końcowe, zaakceptowane D11/D12 mają pierwszeństwo przed historycznymi akapitami.

## Uruchomienie deweloperskie

Wymagane: Node.js zgodny z Vite, Rust/Cargo, Microsoft C++ Build Tools/Windows SDK, WebView2.

```powershell
npm ci
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

Na komputerze, na którym Windows blokuje niepodpisane pliki (wcześniej błąd 4551), testy Rust i E2E wykonuj w izolowanym Windows CI. **Nie wyłączaj mechanizmów bezpieczeństwa systemu**. Podgląd makiety (nie zastępuje E2E): `npm run preview:ui`. Kompilacja `npm run tauri build` nie świadczy o gotowości instalatora ani certyfikacji Store.

## Zasady zmian

Prace prowadź przez niewielkie Draft PR; dla każdego zapisz SHA, rzeczywiście wykonane joby i środowisko, wynik review, blokery oraz powiązaną kartę Notion. **Nie scalaj do `main` bez aktualnej, jednoznacznej zgody właściciela.** Nie oznaczaj `Zrobione` ani `QA PASS` na podstawie samego zielonego CI. Pełne reguły: [WORKFLOW-GOVERNANCE](docs/WORKFLOW-GOVERNANCE.md).

### Archiwum

Poprzedni opis prototypu (15–16.11.2026) znajduje się w [archiwum README](docs/archive/README-20261116.md). Zawiera historyczne wyniki i nie powinien być używany jako opis bieżącego stanu.

# Gavin: perché si impara a fatica, e cosa può sistemare l'agente da solo

Manolo Zocco, 22 ottobre 2026

## Da dove vengono i dati

Nessun utente è stato intervistato. Le prove vengono da tre fonti, tutte nel repository:

- il codice dell'app, del daemon e di `gavin-mcp`, letto per aree (avvio e configurazione, impostazioni, concetti e regole, conflitti tra agenti);
- lo storico git disponibile, che è un clone superficiale di 266 commit dal 26 settembre al 21 ottobre 2026, di cui 74 sono `fix(...)`;
- il backlog: le 40 card attive in `.gavin-root/plans/` e le 677 archiviate.

Le cifre che seguono sono state contate sul codice; dove una cifra è una stima lo dico. Il limite è evidente: questo rapporto descrive dove il software *può* far inciampare, e lo storico dice dove ha già fatto inciampare chi lo sviluppa. Quanto pesino questi attriti su un utente nuovo andrebbe misurato con persone vere (vedi l'ultima sezione).

Un indizio è arrivato prima ancora di leggere una riga. In questa stessa sessione di lavoro il server MCP `gavin` è morto all'avvio con un laconico `CONNECTION_CLOSED`: `scripts/gavin-mcp` non trova nessun binario sulla macchina e lo scrive su stderr, che il client dell'agente non mostra. È il primo attrito di cui parla il PRD, ed è anche il più frequente nello storico.

## In breve

Gavin insegna le proprie regole agli agenti e quasi mai all'umano. Le quattro skill che installa in ogni workspace contano 981 righe e 8.301 parole (`app/src-tauri/src/gavin_*_skill.md`); all'utente arrivano un wizard di dieci passi, 178 tooltip e qualche stato vuoto che spiega. Chi usa l'app scopre la maggior parte delle regole andandoci a sbattere.

Il secondo tratto comune: quando qualcosa si rompe, si rompe senza rumore. L'agente parte senza i tool `gavin_*`, una card salta fuori dal suo piano, un campo nuovo viene scartato da un daemon più vecchio, uno status scritto male crea una colonna. Il daemon spesso ha già il segnale che servirebbe per accorgersene, e non lo mostra.

Il terzo: le manopole sono tante (una sessantina di impostazioni con nome, circa 250 valori se si contano i profili agente uno per uno, stima) e l'agente non ne può leggere né toccare nessuna, tranne i quattro campi di una singola card. Ogni configurazione passa quindi per le mani dell'utente, anche quando la risposta giusta si potrebbe ricavare dall'ambiente.

Da qui le tre direzioni che propongo: far parlare i guasti (una diagnostica unica che l'agente può leggere e riparare), dare all'agente accesso alle impostazioni dietro il cancello di fiducia che esiste già, e prevenire i conflitti con quello che il sistema misura invece di affidarsi a regole scritte nei prompt.

## 1. L'integrazione con l'agente si rompe in silenzio

È la classe di guasto più ricorrente. Dei 74 fix nello storico disponibile, 16 riguardano il collegamento tra Gavin e una CLI di agente (classificazione fatta a mano commit per commit), e tra le card archiviate 18 nominano una CLI e 16 contengono "mcp". Ogni CLI nuova porta il suo file di configurazione, il suo modello di fiducia e i suoi flag; quando uno di questi pezzi si sposta, il sintomo è quasi sempre lo stesso: l'agente lavora senza `gavin_*` e nessuno se ne accorge.

Cosa succede oggi, verificato nel codice:

- In ogni repository che non sia il checkout di Gavin, la voce MCP scritta nella configurazione dell'agente è il percorso **assoluto** di `gavin-mcp` accanto all'app in esecuzione (`mcp_command`, `app/src-tauri/src/agent_setup.rs:2300`). Se l'app viene spostata o reinstallata altrove, quel percorso muore e niente lo rileva.
- Il passo "Integration" del wizard si considera completato appena trova il blocco `<!-- gavin:start -->` nel file di istruzioni (`app/src/lib/workspace/setupWizard.ts:205`). Che la voce MCP esista, e che il comando che nomina si possa eseguire, non viene controllato. Un workspace con il server morto mostra il passo in verde.
- Il daemon sa già quando il `gavin-mcp` di una sessione si presenta (`note_agent_ready`, `crates/daemon/src/server.rs:502`). Usa l'informazione solo per decidere quando incollare il prompt. Nessuna interfaccia dice "questo agente non ha mai collegato i suoi tool".
- `gavin-mcp` costruisce una diagnosi della connessione fallita (`ConnectDiagnosis`: socket, errno, chi tiene il lock, `crates/gavin-mcp/src/main.rs:109-155`) e la scrive in un log e nell'errore del tool. All'app non arriva.
- Le riparazioni esistenti sono bottoni ("Set up integration" nel wizard, "Set up / update" nelle impostazioni del workspace): funzionano, a patto di sapere che vanno premuti.

**Cosa cambierei.** Un controllo di salute per sessione: se una sessione agente non ha fatto Hello entro qualche secondo dall'avvio, la tab mostra un segno e, al clic, la riga di log di `gavin-mcp` con la causa. Con quel segnale in mano l'app può rilanciare `setup_agent_integration` da sola, perché la funzione è già idempotente e rispetta i server MCP estranei. Il passo "Integration" diventerebbe verde solo quando la voce MCP esiste e il comando risolve a un eseguibile.

Il caso del checkout di Gavin merita una nota a parte. Lì la voce è relativa (`scripts/gavin-mcp`), e lo script prova nell'ordine `GAVIN_MCP`, le due cartelle Applications di macOS, `target/release`, `target/debug` e il PATH. Su Linux senza pacchetto installato, come in questo container, nessun candidato esiste. Lo script lo scrive su stderr con la lista dei percorsi provati, ottima cosa, solo che quasi nessun client lo mostra: basterebbe che lo stesso messaggio finisse anche nel log che l'app legge.

## 2. Tante manopole, nessuna in mano all'agente

Le impostazioni vivono in quattro posti: `config.json` dell'app (globali e per workspace, ADR 0006), `.gavin-root/config.toml` nel repository, i metadati di fiducia del daemon per l'accesso remoto, più una ventina di preferenze d'interfaccia in localStorage. La pagina delle impostazioni globali ha 17 sezioni (`GlobalSettingsView.svelte`), quella del workspace 12.

Gli agenti non possono leggerne nessuna. I 19 tool di `gavin-mcp` coprono card, piani, rail, tool, memorie e sessioni; di impostazioni si toccano solo `complexity`, `agent`, `model` ed `effort` di una singola card (`crates/gavin-mcp/src/main.rs:721-723`).

Alcuni incastri che un utente fatica a ricostruire:

- **Chi esegue una card** si decide su cinque livelli: i campi della card, la riga della tabella di complessità, `[agent]` del workspace, il default per profilo dell'app, e in fondo `claude-code`. Quando scatta la catena di fallback, i campi della card vengono ignorati di proposito (`app/src/lib/cards/complexity.ts:285-312`).
- **Le tabelle di complessità nascono vuote** (`app/src-tauri/src/config.rs:861-868`). La descrizione MCP dice all'agente che "the human maps each level to an agent and model" (`main.rs:718`), quindi l'agente valuta le card con cura e la valutazione non ha nessun effetto finché qualcuno non compila venti celle per profilo. A schermo non c'è traccia di questo vuoto.
- **Due soglie d'uso** vicine e diverse: 90% per passare al prossimo agente della catena, 95% per mettere in pausa i resume. Una pausa ciclica blocca tutto anche con la catena configurata; una pausa da limite cede alla catena (`app/src/lib/agents/agentFallback.ts:8-11`).
- **Ereditarietà per chiave**: nel workspace un valore vuoto è una scelta esplicita e sostituisce quello dell'app (`agentPrimary.ts:6-13`). Un utente che svuota un campo pensando di "tornare al default" ottiene l'opposto.
- `[worktree] setup` non ha nessun editor: si scrive a mano in `config.toml` e resta spento finché un umano lo approva tramite l'hash di fiducia (`workspaceTrust.ts`).
- La ricerca nelle impostazioni confronta parole con liste scritte a mano per sezione. Nell'esperimento del 21 settembre trovava la sezione giusta per 4 domande su 41 formulate a parole proprie; il ripiego "per significato" ne recuperava 34 su 37, ma richiede TypeSafe acceso e una chiave API, entrambi spenti di default.

**Cosa cambierei.** Prima di tutto un tool in sola lettura, `gavin_get_effective_config`, che restituisca la configurazione *risolta* per il workspace corrente: quale agente e quale modello partono per ogni livello di complessità, quali soglie valgono, da quale livello arriva ogni valore. Per l'utente varrebbe la stessa vista nelle impostazioni ("questa card partirà con…"), che oggi bisogna ricostruire a mente.

Poi la scrittura, con un criterio chiaro su cosa l'agente può fare da solo (sezione 7). Per tutto ciò che tocca comandi eseguiti, come `[agent] command` e `[worktree] setup`, il meccanismo c'è già: l'agente scrive la proposta, il cancello di fiducia la tiene spenta, l'umano approva. Manca solo il tool che la scriva e una `Decision:` sulla card che la segnali.

Infine i valori da dedurre al primo avvio invece di chiederli:

| Impostazione | Da dove si ricava | Stato oggi |
|---|---|---|
| Agente principale e catena di fallback | CLI trovate nel PATH | già automatico (`AgentStep.svelte:105-140`) |
| Tabella di complessità | CLI installate, piano d'abbonamento letto dalle sonde d'uso (`agent_usage.rs`, `plan_type`) | vuota |
| Comandi di setup dei worktree | lockfile e toolchain del repository (`package-lock.json`, `Cargo.lock`, `uv.lock`…) | assente, nessun rilevamento |
| Limite di agenti in parallelo | RAM totale e memoria media misurata per agente (`launchEstimate.ts`) | fisso a 4 |
| Percorso del PRD | PRD già presente nel repository | già automatico (`PrdStep`) |
| Tracciamento git di `.gavin*` | stato del repository e `.gitignore` | chiesto nel wizard |

Sulla tabella di complessità e sul limite da RAM non ho prove che la deduzione darebbe valori migliori: sono ipotesi da verificare. Sul setup dei worktree la deduzione è meccanica e la conferma umana resta, quindi il rischio è basso.

## 3. Circa 75 concetti e regole che nessuno annuncia

Un utente nuovo incontra una settantina di concetti distinti (stima ragionata, contando strutture, tipi di card e campi, modalità di avvio, elementi dell'orchestrazione e superfici di attesa) e 13 viste per workspace (`app/src/lib/hub/hubViewMeta.ts:20-65`). La quantità da sola si potrebbe gestire con una buona progressione. Pesano di più due cose: alcune parole indicano più oggetti, e alcune regole agiscono senza avvisare.

**Parole sovraccariche.**
"Review" indica sei cose: la tab Review, il passo di revisione manuale di una rail (che però compare nella tab Decisions), la revisione obbligatoria prima del primo Run, la code review, la critical review e un passo del wizard. "Memory" ne indica tre: le card-memoria da adottare in `CLAUDE.md`, l'indice semantico preparato dal passo "Memory" del wizard, il muro di RAM. "Hub" ne indica tre, tanto che `CONTEXT.md:79` deve avvertire. "In attesa di te" compare in almeno sei punti, e i due insiemi principali (Decisions e la inbox) sono diversi per scelta (`decisions.ts:4-15`).

**Regole mute**, verificate nel codice:

1. Lanciare un task annidato scrive `In Progress` e lo **sgancia per sempre** dal piano (`cardRunActions.ts:864`, scelta deliberata). La card salta fuori dal suo genitore e nessuno spiega perché.
2. Lo status è testo libero (`crates/daemon/src/gavin.rs:1688`): uno status scritto male da un agente crea una colonna automatica, e la scrittura MCP non restituisce nessun avviso.
3. "Done" ha due significati. Il file si sposta in `plans/done/` solo se lo status è letteralmente `done` (`gavin.rs:1239`); rail e MCP considerano fatta la colonna più a destra. Basta una colonna "Shipped" dopo Done per separare le due regole.
4. Se in `plans/done/` esiste già un file con lo stesso nome, lo spostamento viene saltato con un `eprintln` nel log del daemon (`gavin.rs:1535-1541`). La card resta dov'era.
5. Un `parent:` che punta a un task, a sé stesso o a un altro contesto produce un avviso "file not found in this context", fuorviante quando il file esiste ed è semplicemente del tipo sbagliato.
6. Le voci `Decision:` e `Human test:` ancora aperte su una card finita in Done o in archivio spariscono da entrambe le tab (`decisions.ts:23-29`).
7. `direct: true` vuol dire che niente sposterà mai la card; su una rail il passo resta fermo finché qualcuno preme "Mark done".

L'agente vede ancora meno dell'umano: in `gavin_get_tree` ogni card porta un solo booleano `parseWarning` (`crates/gavin-mcp/src/cards.rs:99`), senza dire quale campo, senza segnalare un genitore rotto o uno status che non corrisponde a nessuna colonna.

**Cosa cambierei.** Un linter delle card, eseguito dal daemon a ogni modifica e esposto sia nell'interfaccia sia in `gavin_get_tree` come lista di avvisi per campo. Molte correzioni sarebbero automatiche e sicure: proporre la colonna più vicina a uno status sconosciuto, riallineare status e cartella, segnalare i doppioni di nome, spiegare perché un genitore non vale. Le altre diventano una `Decision:` con le opzioni. Il precedente esiste già, è l'azione "Clean stale" (`decisions/cleanStale.ts`).

Sul vocabolario: rinominare almeno la tab Review (ad esempio "Risultati") e il passo "Memory" del wizard ("Ricerca nelle memorie"), e far confluire le superfici di attesa in una sola lista con filtri. È lavoro di interfaccia, poco codice e molte decisioni, quindi va deciso da una persona.

Una nota che mi è venuta rileggendo il README: il Companion ha una Demo Workstation con sessioni, card e rail finte, pensata proprio per esplorare l'app prima di collegare qualcosa. Il desktop non ha niente di simile. Un workspace di prova, con una card per tipo, una rail di due stadi e una decisione in sospeso, insegnerebbe metà dei concetti senza una riga di documentazione.

## 4. Conflitti: le regole stanno nei prompt, le misure non bloccano

La prevenzione dei conflitti tra agenti oggi si regge su due cose: tenerli in worktree separati, quando qualcuno lo sceglie, e segnalare i problemi a livello di checkout o di card. Nessun meccanismo controlla, file per file, che due agenti non stiano scrivendo nello stesso posto.

- Il worktree viene scelto automaticamente solo da Best-of-N e dall'agente di orchestrazione. Run, "Start all", Resume e le sessioni avviate via MCP partono sempre nel checkout principale (`cardRun.ts:106-108`).
- "Start all" su una colonna mette N agenti nello stesso checkout. Il dialogo di conferma elenca i titoli e la stima di memoria (`columnRunAction.ts:174-189`), senza avvertire che lavoreranno sugli stessi file.
- "Commit only the files you touched, never `git add -A`" è una frase nel prompt (`app/src/lib/git/autoCommit.ts:44-46`). L'hook che osserva i comandi shell dichiara di sé "Observation only… exits 0 whatever happened" (`crates/gavin-mcp/src/shell_writes.rs:22`): registra, non ferma.
- Il "commit via agent" e il passo `builtin:commit` committano tutto quello che trovano nel checkout, compresi i file a metà di altri agenti ancora al lavoro. Esiste uno strumento più prudente, `builtin:consolidate-repo`, che fa staging per percorso e lascia fuori ciò che non sa attribuire (`orchestrationTools.ts:870-900`).
- I conflitti dell'orchestrazione (stesso worktree in uno stadio parallelo, card duplicata, branch mancante) vengono calcolati quando la tab viene disegnata, e per regola di progetto (O4) non bloccano mai un avvio. Lo scheduler non li legge. Le sessioni avviate dalla board non entrano nel calcolo.
- `gavin_get_orchestration` passa all'agente di orchestrazione i file modificati solo per le rail legate a un worktree (`crates/gavin-mcp/src/main.rs:1468-1476`). La rail senza worktree, cioè quella che condivide il checkout principale e corre più rischi, arriva con la lista vuota.
- L'editor dei conflitti nella tab Git è a tre pannelli e manuale. La risoluzione con un agente esiste, ma solo come passo di una rail (`builtin:merge`).

Prevedere i conflitti dal testo delle card è già stato provato e scartato con buone ragioni: su 300 coppie, a soglia 0,5, il modello mancava 34 collisioni reali su 37 (`docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md:136-140`). La strada è usare quello che si misura.

**Cosa cambierei.**

- Prima di un avvio dalla board, se nello stesso checkout ci sono già sessioni vive, proporre "ognuna nel suo worktree" riusando la logica di Best-of-N per nomi di cartelle e branch, e il `[worktree] setup` dedotto al punto 2.
- Incrociare in tempo reale i registri `shell-writes` e le letture dei transcript (`agent_edits.rs`) tra sessioni dello stesso checkout. Quando la sessione B scrive un file che A ha appena scritto, avvisare entrambe: una riga nel prossimo prompt di ciascun agente e un segno sulla tab per l'umano.
- Far rifiutare a `builtin:commit` e al commit via agente il commit totale quando ci sono altre sessioni vive nel checkout, passando invece a staging per percorso con la lista dei file della run.
- Dare all'agente di orchestrazione i file modificati anche per le rail senza worktree, presi dallo stato del checkout principale.
- Un bottone "Risolvi con un agente" nella vista dei conflitti della tab Git, con lo stesso testo di `builtin:merge` (capire i due lati, far girare i test, abbandonare se non sicuro).
- Un'eccezione opzionale e reversibile alla regola O4: un conflitto "live" sullo stesso worktree sospende l'avvio dello stadio successivo finché non lo si conferma.

Resta un punto tecnico, perché le build dev e release condividono `orchestration.sqlite` per scelta (spec `2026-09-11-per-build-daemon-isolation-design.md`): `set_step_run` sovrascrive lo stato senza controllare quello attuale (`crates/daemon/src/orchestration.rs`), e l'ho dedotto dal codice senza riprodurlo. In una prima versione di questo rapporto segnalavo anche l'assenza di un busy timeout sull'apertura del database: era sbagliato, perché `rusqlite` ne imposta uno di 5 secondi da sé (`inner_connection.rs:121` della versione 0.31), e un test con due connessioni sullo stesso file lo conferma.

## 5. Il primo avvio chiede troppo, e controlla poco

Il wizard di inizializzazione è passato dai 4 passi della spec ai 10 di oggi (`setupWizard.ts:178-189`): agente, integrazione, skill di Matt Pocock, Headroom, indice delle memorie, Playwright, git, revisione prima del Run, PRD, avvio.

- Il banner della Home dice "N di 10 fatti", ma il workspace risulta configurato ignorando cinque passi (`setupWizard.ts:260-268`). "5 di 10" può significare che non manca niente. Correzione banale: contare solo i passi che contano.
- Il rilevamento delle CLI cerca i binari nel PATH senza eseguirli (`agent_setup.rs:4258-4326`). Una CLI senza login o senza licenza risulta "trovata", e il wizard la imposta come agente principale senza chiedere. Un `--version` o una sonda di autenticazione eviterebbero la sorpresa al primo Run.
- I prerequisiti si scoprono tardi e uno per volta: Node solo dentro il passo Playwright, uv solo dentro Headroom, Git for Windows solo quando una sessione non parte perché il daemon ripiega su un `sh.exe` nudo (`crates/daemon/src/shell.rs:40`). Una verifica unica all'avvio dell'app, che riusa i rilevatori dei singoli passi, darebbe un quadro solo.
- Le domande di fiducia sono quattro (configurazione del repository, server MCP estranei, launcher del checkout, revisione prima del Run). Ognuna è giusta da sola; insieme chiedono a chi arriva di aver capito il modello di minaccia prima di aver visto una card. Due si potrebbero rinviare al momento in cui servono davvero.

## 6. La documentazione resta indietro rispetto al codice

Il PRD dice `PROTOCOL_VERSION (41)`; il codice è a 78 (`crates/protocol/src/lib.rs:1027`). Il punto 1 del "Current focus" chiede di rendere `.mcp.json` indipendente dalla macchina e di introdurre il re-exec di `gavin-mcp`: entrambe le cose sono fatte, e la card del re-exec è archiviata come Done. `docs/dev-setup.md:130-134` sostiene che manca il bundling dei sidecar, mentre `tauri.bundle.conf.json` li include da tempo. La descrizione di `gavin_get_board` promette "the human's free-form cards" e restituisce solo colonne ed etichette.

Per un utente nuovo la documentazione è il primo appiglio, e se il primo appiglio è sbagliato la curva si alza ancora. Questo è il lavoro più adatto a un agente: un tool di Gavin (o una rail programmata) che confronta i numeri e le affermazioni verificabili dei documenti con il codice e apre una card quando divergono.

## 7. Quando l'agente può fare da solo, e quando deve chiedere

Il PRD fissa un principio, "the human keeps the wheel", e lo applica a commit, merge e cambio di un checkout sporco. Per la configurazione serve un criterio altrettanto netto, altrimenti ogni nuova impostazione finisce nel pannello per prudenza. Propongo quattro domande, in quest'ordine:

1. **Il valore si ricava dall'ambiente con certezza?** (una CLI è installata, un lockfile c'è, un percorso esiste). Allora l'agente lo imposta e lo annota, senza chiedere.
2. **L'effetto è reversibile e resta su questa macchina?** (riparare una voce MCP, riallineare una card con la sua cartella, scegliere un worktree per un avvio parallelo). L'agente agisce e lascia una riga visibile su cosa ha fatto.
3. **Fa girare un comando, spende soldi o quote, o manda dati fuori dalla macchina?** (`[worktree] setup`, `[agent] command`, tabella di complessità, TypeSafe, Headroom). L'agente propone; il cancello di fiducia o una `Decision:` con le opzioni fanno decidere l'umano con un clic.
4. **Tocca la sicurezza o l'identità?** (accesso remoto, Relay, dispositivi, aspetto dell'app). Resta manuale.

Applicato alle impostazioni censite, il criterio sposta nella prima o nella seconda fascia la riparazione dell'integrazione, il setup dei worktree (come proposta), il limite di parallelismo, la normalizzazione delle card e la scelta del worktree per gli avvii paralleli. Tiene nella terza la tabella di complessità e la catena di fallback, e nella quarta tutto l'accesso remoto.

## Priorità

Impatto e sforzo sono stime mie, ragionate sul codice da toccare; vanno prese come ordine di grandezza.

| # | Intervento | Impatto | Sforzo |
|---|---|---|---|
| 1 | Segno "tool gavin assenti" per sessione dal mancato Hello, con log e riparazione automatica dell'integrazione | alto | basso |
| 2 | Avvisi per campo in `gavin_get_tree` e avviso su status sconosciuto in `gavin_set_plan_field` | alto | basso |
| 3 | Banner del wizard che conta solo i passi rilevanti; passo Integration verde solo con MCP funzionante | medio | basso |
| 4 | Aggiornare PRD, `dev-setup.md` e descrizione di `gavin_get_board` | medio | basso |
| 5 | `gavin_get_effective_config` in sola lettura, e la stessa vista "questa card partirà con…" nelle impostazioni | alto | medio |
| 6 | Avviso e proposta di worktree prima di avvii paralleli nello stesso checkout; commit via agente per percorso quando il checkout è condiviso | alto | medio |
| 7 | Linter delle card con correzioni automatiche e `Decision:` per i casi ambigui | alto | medio |
| 8 | Proposta automatica di `[worktree] setup` dai lockfile, approvata tramite il cancello di fiducia | medio | medio |
| 9 | Verifica unica dei prerequisiti all'avvio dell'app; sonda di funzionamento delle CLI | medio | medio |
| 10 | Rilevamento in tempo reale di due sessioni che scrivono lo stesso file | alto | alto |
| 11 | Workspace dimostrativo sul desktop; revisione dei nomi sovraccarichi | alto | medio, con molte decisioni di prodotto |
| 12 | Transizioni controllate su `orchestration.sqlite` (il busy timeout c'è già) | basso per l'utente, medio per la robustezza | medio |

I primi quattro si possono fare in pochi giorni e tolgono di mezzo i guasti muti più frequenti. Dal quinto in poi serve una decisione di prodotto per ciascuno.

## Cosa non sappiamo ancora

Tutto quanto sopra è dedotto dal codice e dallo storico di chi sviluppa Gavin, che è anche il suo utente più esperto. Il dubbio che mi resta è quale di questi attriti blocchi davvero chi arriva da fuori. Un test con tre o quattro persone che non hanno mai visto l'app, con un compito semplice ("fai lavorare due agenti su due card senza che si pestino i piedi") e la registrazione dei punti in cui si fermano, direbbe in un pomeriggio se l'ordine delle priorità regge.

Altre cose rimaste aperte: non ho verificato se un'installazione Linux da AppImage trova `gavin-mcp`; non ho riprodotto la corsa tra build dev e release su `orchestration.sqlite`; non ho misurato quanto siano lunghe le descrizioni dei 19 tool MCP, che si sommano alle 8.301 parole delle skill nel contesto di ogni agente.

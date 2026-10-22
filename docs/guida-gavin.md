# Guida a Gavin: dal primo avvio a un progetto orchestrato

Questa guida accompagna chi apre Gavin per la prima volta su un Mac e vuole
vedere, su un caso concreto, come l'app fa lavorare più agenti insieme. Si
parte dalle basi (perché nello Scratchpad non succede niente, come si crea un
workspace) e si arriva a un piccolo progetto in cui tre agenti diversi
lavorano in parallelo, ciascuno nel proprio ramo git, e un quarto rail
raccoglie il lavoro, lo verifica e chiede a te l'ultima parola.

I nomi di pulsanti, menu e finestre sono riportati in inglese, esattamente
come compaiono nell'app, così si trovano a colpo d'occhio.

---

## 1. Come ragiona Gavin, in poche righe

- **Gavin non contiene un agente suo.** Apre un terminale vero e ci lancia
  dentro le CLI che hai già installato: `claude`, `agy` (Antigravity),
  `opencode`, `codex`, `agent` (Cursor), `kimi`. Usa i loro login, quindi se
  un agente funziona nel Terminale del Mac funziona anche in Gavin.
- **Un workspace è una cartella.** Card, kanban, orchestrazione e scelta
  dell'agente esistono solo in un workspace collegato a una cartella del
  disco, che Gavin chiama *root*. Dentro la cartella Gavin crea
  `.gavin-root/`, con il PRD (il documento guida del progetto), la
  configurazione e le card.
- **Lo Scratchpad è un cassetto senza cartella.** È la riga fissa in cima
  alla barra laterale: serve per aprire terminali al volo, e lì nessun agente
  viene lanciato su una card. Se provi a creare una card nello Scratchpad,
  Gavin risponde con *"No gavin context to create in"*. Il messaggio vuol dire
  proprio questo: manca una cartella.
- **Una card è un file markdown.** Il corpo della card è il prompt che
  l'agente riceve. Le card stanno in `.gavin-root/plans/` e si muovono sulla
  kanban tra le colonne To Do, In Progress e Done.
- **Un rail è una colonna di passi in ordine.** Ogni passo è una card o uno
  strumento (fare un commit, lanciare un controllo, attendere una tua
  revisione, mandare una notifica). Un rail può lavorare in un suo *worktree*
  git, cioè in una copia separata del progetto su un ramo suo, così più rail
  procedono in parallelo senza pestarsi i piedi.

---

## 2. Prima di cominciare

### 2.1 Gli agenti

Ti serve almeno un agente installato e con il login fatto. Per l'esempio
completo ne servono tre: Claude Code, Antigravity e opencode. Se ne hai uno
solo, puoi seguire la guida assegnando lo stesso agente a tutte le card.

Controlla dal Terminale del Mac (Cmd + Spazio, scrivi "Terminale", Invio):

```sh
which claude agy opencode
```

Per ogni agente installato compare un percorso. Gavin cerca da solo anche in
`~/.local/bin`, `~/.claude/local`, `~/.opencode/bin`, `~/.kimi-code/bin`,
`~/.bun/bin`, `~/.cargo/bin`, `/opt/homebrew/bin` e `/usr/local/bin`. Le serve
perché un'app aperta dal Dock non eredita il PATH del Terminale. Se il tuo
agente sta altrove (per esempio dentro una cartella di `nvm`), nella
configurazione guidata scriverai il percorso completo nel campo **Command**.

Se non hai mai usato un agente da terminale, aprilo una volta lì e completa
il suo login prima di passare a Gavin.

### 2.2 Git

L'esempio usa i worktree, quindi serve git. Sul Mac arriva con gli strumenti
da riga di comando di Xcode: se `git --version` non risponde, installali con
`xcode-select --install`.

---

## 3. Il progetto d'esempio: un Ricettario

Costruiremo una paginetta web statica, senza dipendenze, divisa in tre file
che tre agenti scrivono in parallelo:

| File          | Cosa contiene                                 | Chi lo scrive |
|---------------|-----------------------------------------------|---------------|
| `index.html`  | lo scheletro della pagina                     | Claude Code   |
| `style.css`   | l'aspetto                                     | opencode      |
| `ricette.js`  | tre ricette e il codice che le mostra         | Antigravity   |

Un quarto passaggio, affidato di nuovo a Claude Code, collega i tre file e
verifica il risultato con un piccolo script di controllo.

### 3.1 Prepara la cartella

Nel Terminale del Mac:

```sh
mkdir ~/ricettario
cd ~/ricettario
git init -b main
```

Poi crea lo script di controllo che userà l'ultimo rail. Copia e incolla
tutto il blocco:

```sh
cat > check.sh <<'EOF'
#!/bin/sh
for f in index.html style.css ricette.js; do
  [ -f "$f" ] || { echo "manca $f"; exit 1; }
done
grep -q 'style.css' index.html || { echo "index.html non collega style.css"; exit 1; }
grep -q 'ricette.js' index.html || { echo "index.html non collega ricette.js"; exit 1; }
echo "tutto a posto"
EOF
```

Il commit iniziale lo farai più avanti (al punto 6), quando Gavin avrà
scritto i suoi file di integrazione: i worktree nascono da quel commit, e gli
agenti che ci lavorano dentro devono trovarci la configurazione che li
collega a Gavin.

---

## 4. Crea il workspace

1. Nella barra laterale, in basso, clicca **Gavin**. Si apre la panoramica
   dell'app, con la colonna **Workspaces**.
2. Clicca **+ New workspace…**, scrivi `Ricettario` e premi Invio.
3. Si apre la finestra **Set up "Ricettario"**. Alla voce **Folder** premi
   **Set root…** e scegli la cartella `ricettario` appena creata.
4. Gavin chiede **Initialize gavin in this folder?** Spunta
   **Track gavin's files in git**, se non lo è già, e premi **Initialize**. Gavin crea
   `.gavin-root/` con il PRD, `config.toml` e le cartelle `plans`, `docs`,
   `specs`, senza toccare quello che c'è già.
5. Scegli un colore se vuoi, poi premi **Continue →**: parte la
   configurazione guidata.

> **Strada alternativa.** L'icona a forma di cartella in alto a sinistra
> (**Open workspace…**) apre direttamente una cartella. In quel caso la
> configurazione guidata non parte da sola: la ritrovi nel tab **Home** del
> workspace, alla voce **Finish setting up this workspace**.

---

## 5. La configurazione guidata, passo per passo

La guida ha dieci passi, in alto vedi a che punto sei. Ogni **Continue →**
porta al successivo. Si può riaprire in seguito, e quasi tutto si cambia
poi dalle impostazioni.

**1. Agent: "Which agent?"**
In cima Gavin elenca gli agenti che ha trovato (*Found: …*). Nel menu
**Profile** ognuno compare con *(found)* o *(not found)*.
- Scegli **Claude Code** come agente principale del workspace.
- **Command** mostra il comando che Gavin lancerà. Cambialo solo se
  l'agente sta in una cartella che Gavin non conosce (vedi 2.1).
- **Instructions** è il file di istruzioni dell'agente (per Claude Code è
  `CLAUDE.md`). Lascialo com'è.
- **Pause**: una pausa programmata per non consumare l'abbonamento mentre
  nessuno guarda. Per la prova puoi lasciarla spenta.
- **Fallback**: con **Add fallback** aggiungi **Antigravity** e poi
  **opencode**. È la catena che Gavin usa quando l'agente principale ha
  esaurito i limiti, e nel nostro esempio serve anche a un'altra cosa:
  aggiungere un agente alla catena è il modo in cui Gavin lo prepara per
  questo workspace (vedi il punto 6).

**2. Integration: "Integration files"**
Premi **Set up integration**. Gavin scrive i file che insegnano all'agente
come usare il workspace: per Claude Code sono un blocco delimitato in
`CLAUDE.md`, la configurazione MCP in `.mcp.json` e quattro skill in
`.claude/skills/` (gavin, gavin-develop, gavin-orchestrate, gavin-resume).
Attraverso il server MCP l'agente vede la kanban e può, per esempio, spostare
la sua card in Done quando ha finito. Senza questo passo l'orchestrazione non
sa quando un passo è concluso.

**3. Matt Pocock's skills**
Skill facoltative di ingegneria (TDD, ricerca dei bug, ecc.). Per l'esempio
premi **Not now**.

**4. Headroom**
Comprime ciò che gli agenti mandano al modello per risparmiare limiti. È
facoltativo e parte spento: per la prova lascialo così.

**5. Memory**
Indice locale per cercare per significato tra i fatti che adotti nel file di
istruzioni. Facoltativo: **Not now**.

**6. Playwright**
Un browser che gli agenti usano per controllare le interfacce che scrivono.
Richiede Node.js e scarica circa 200 MB. Per il Ricettario non serve:
**Not now**.

**7. Git**
Scegli **Commit them with the project**: PRD e card finiscono nel
repository insieme al codice. Se hai già risposto con la casella del punto
4, il passo risulta fatto e puoi andare avanti.

**8. Review: "Review before Run"**
Lascia **Require review** acceso. Prima che il corpo di una card arrivi a un
agente per la prima volta, Gavin ti mostra esattamente cosa riceverà e chiede
un sì esplicito. Nel punto 7 vedrai come si fa.

**9. PRD: "The PRD"**
Il documento guida del progetto, che l'agente legge per primo. Scrivi due
righe in **Vision**, per esempio: *"Una pagina web statica che mostra tre
ricette italiane, senza dipendenze e senza build."* Poi **Continue →**.

**10. Launch: "Start your agent"**
Avvia l'agente principale nella root del progetto. Per l'esempio non serve:
premi **Not now**.

---

## 6. Prepara gli altri due agenti e fai il primo commit

Quando torni sul workspace, Gavin si accorge che Antigravity e opencode sono
nella catena di fallback ma non ancora configurati qui, e apre una finestra
**Set up Antigravity as a fallback**. Esegui il passo di integrazione (scrive
`GEMINI.md`, `.agents/mcp_config.json` e le skill in `.agents/skills/`), salta
pure le skill facoltative, e chiudi. Subito dopo arriva la stessa finestra per
opencode, che scrive `AGENTS.md`, `opencode.json` e `.opencode/skills/`.

Se una delle due finestre non compare, cambia workspace e torna su
Ricettario: Gavin la ripropone ogni volta che il workspace riprende il fuoco.

Adesso fai il commit di partenza, sempre dal Terminale:

```sh
cd ~/ricettario
git add -A
git commit -m "Punto di partenza"
```

Se git risponde *"Please tell me who you are"*, configura nome ed email una
volta per tutte con `git config --global user.name "Nome Cognome"` e
`git config --global user.email "tu@esempio.it"`, poi ripeti il commit.

---

## 7. Le quattro card

Apri il tab **Kanban**: nella barra laterale, sulla riga del workspace
Ricettario, clicca l'icona a forma di casa (**Hub**) e scegli **Kanban** tra
i tab in alto.

Per ciascuna card: **+ Add card** in fondo alla colonna To Do (oppure ⌘N),
tipo **task**, titolo e corpo come qui sotto, **Complexity** lasciata su
*unrated*, nessuna casella spuntata, poi **Add card**.

**Card 1: "Scheletro della pagina"**

```text
Crea il file index.html nella radice del progetto: una pagina HTML5 in
italiano con titolo "Ricettario", un'intestazione h1, un paragrafo
introduttivo di una riga e un elemento <main id="ricette"></main> vuoto.
Non aggiungere CSS né JavaScript e non creare altri file: se ne occupano
altre card. Quando hai finito, sposta questa card in Done.
```

**Card 2: "Foglio di stile"**

```text
Crea il file style.css nella radice del progetto. La pagina ha un h1, un
paragrafo introduttivo e un elenco di ricette: ogni ricetta è un
<article class="ricetta"> con un h2, un elenco ul di ingredienti e un
paragrafo con classe "procedimento". Dai a tutto uno stile sobrio e
leggibile, che funzioni anche su schermi stretti. Non toccare altri file.
Quando hai finito, sposta questa card in Done.
```

**Card 3: "Dati delle ricette"**

```text
Crea il file ricette.js nella radice del progetto. Deve contenere un array
RICETTE con tre ricette italiane semplici (titolo, ingredienti,
procedimento) e del codice che, al caricamento della pagina, inserisce
dentro l'elemento #ricette un <article class="ricetta"> per ogni ricetta,
con un h2 per il titolo, un ul per gli ingredienti e un paragrafo con
classe "procedimento". Non toccare altri file. Quando hai finito, sposta
questa card in Done.
```

**Card 4: "Collega tutto"**

```text
In index.html collega style.css nell'head e ricette.js prima della
chiusura del body. Controlla che le classi usate in ricette.js
corrispondano a quelle definite in style.css e correggi le differenze.
Poi esegui sh check.sh: deve stampare "tutto a posto". Fai un commit con
un messaggio chiaro e sposta questa card in Done.
```

### 7.1 Assegna un agente a ogni card

Clicca una card per aprirne il dettaglio. Accanto a **Complexity** trovi il
campo **Agent**, che di base vale *inherit* (cioè l'agente del workspace).
Imposta:

- card 1: **Claude Code**
- card 2: **opencode**
- card 3: **Antigravity**
- card 4: lasciala su *inherit* (Claude Code)

Gavin scrive la scelta nell'intestazione della card (`agent: …`), che vale
sia quando lanci la card a mano sia quando la lancia un rail.

### 7.2 Leggi e approva le card

Nel dettaglio di ogni card c'è un avviso: nessuno ha ancora letto il corpo
della card, e Gavin chiede conferma prima della prima esecuzione. Premi
**Review…**, leggi il prompt completo che l'agente riceverà (Gavin aggiunge
al tuo testo alcune istruzioni sul workspace) e conferma con **Run this**.
Aperta così dal dettaglio, la conferma segna solo la card come letta: a
lanciarla ci penserà il rail.

Se salti questo passaggio non succede niente di grave: il rail si ferma su
quella card con il segnale *needs you* e aspetta che tu la approvi.

> **Una prova veloce, se vuoi.** Prima di costruire i rail puoi creare una
> card usa e getta (per esempio *"Elenca i file del progetto e descrivili in
> una riga"*) e premere **▶ new session** sulla card. Gavin la sposta in In
> Progress, apre un tab con l'agente sulla pagina **Agents** e lega la card a
> quella sessione. Quando hai visto come funziona, eliminala dal menu del
> tasto destro (**Delete…**).

---

## 8. Costruisci i rail

Apri il tab **Orchestration**. A destra c'è il cassetto **Unplaced** con le
card non ancora assegnate a un rail, gli strumenti (**Tools**) e i gruppi
salvati (**Groups**).

Costruiremo quattro rail:

```
 Struttura          Stile              Ricette            Integrazione
 (worktree          (worktree          (worktree          (cartella principale,
  struttura)         stile)             ricette)           parte quando gli altri
                                                           tre hanno finito)
 1. card 1          1. card 2          1. card 3          1. Update from a branch: struttura
 2. Commit changes  2. Commit changes  2. Commit changes  2. Update from a branch: stile
                                                          3. Update from a branch: ricette
                                                          4. card 4
                                                          5. Loop until a check passes
                                                          6. Manual review
                                                          7. Send a notification
```

I primi tre rail lavorano in parallelo, ognuno nella sua copia del progetto.
Il quarto aspetta, poi porta i tre rami nella cartella principale, fa
collegare i file, li verifica e si ferma per farti guardare il risultato.

### 8.1 Crea e configura i rail di lavoro

Ripeti questi passi tre volte, una per **Struttura**, **Stile** e
**Ricette**:

1. Premi **Rail** (il pulsante con il +) nella barra in alto, oppure
   **+ Add rail** in fondo alla fila. Il rail nasce come *New rail* con il
   nome già modificabile: scrivi il nome e premi Invio.
2. Sotto il nome ci sono quattro etichette: worktree, ramo, pagina e
   trigger. Clicca **no worktree**: si apre la finestra **How "…" runs** sul
   tab **Worktree**.
3. Premi **New worktree…**, scegli **New branch**, scrivi il nome del ramo
   in minuscolo (`struttura`, `stile`, `ricette`) e lascia **From** sul
   commit attuale. La cartella proposta è
   `ricettario/.gavin-worktrees/<ramo>`, che Gavin esclude da git da solo.
   Premi **Create worktree**, poi **Done**.
4. In fondo al rail premi **+ Add step**. Nella finestra **Add a step**,
   sotto **Cards**, clicca la card giusta (1, 2 o 3). Ogni clic aggiunge un
   passo in coda.
5. Premi di nuovo **+ Add step** e, sotto **Tools**, scegli **Commit
   changes**: un agente legge le modifiche del worktree e le registra in uno
   o più commit, senza fare push.

### 8.2 Crea il rail di integrazione

1. Crea un quarto rail e chiamalo **Integrazione**. Il worktree non va
   collegato: senza worktree, i suoi passi lavorano nella cartella
   principale del progetto, che è proprio dove vogliamo riunire i tre rami.
   Gavin lo segnala con un avviso nel riquadro dei conflitti (*has steps but
   no worktree*), e qui va bene così.
2. Con **+ Add step** aggiungi, in quest'ordine:
   - **Update from a branch**, tre volte;
   - la card 4, **Collega tutto**;
   - **Loop until a check passes**;
   - **Manual review**;
   - **Send a notification**.
3. Imposta i parametri degli strumenti. Su ogni passo che ne ha c'è il
   pulsante **Tool parameters**, che apre una finestra con un campo per
   parametro e un'anteprima di ciò che il passo farà (**Save** per
   confermare):
   - i tre **Update from a branch**: *Branch to merge in* uguale a
     `struttura`, `stile` e `ricette`;
   - **Loop until a check passes**: comando di controllo `sh check.sh`,
     numero massimo di tentativi `3`. Se il controllo fallisce, il rail torna
     indietro e rilancia il passo precedente (la card 4), passando all'agente
     l'output del controllo;
   - **Send a notification**: un titolo e un messaggio a piacere, per esempio
     `Ricettario` e `Il ricettario è pronto`. Evita le virgolette e gli
     apostrofi nel testo, perché la notifica passa da `osascript` e le
     virgolette la rompono.

### 8.3 Il trigger, per ultimo

Clicca l'etichetta **starts by hand** del rail Integrazione, tab
**Trigger**, e scegli **When every other rail has finished**. Premi
**Done**.

Fallo solo adesso, con gli altri tre rail già pieni: per Gavin un rail
vuoto conta come finito, e un trigger impostato su rail ancora vuoti
partirebbe subito. Sotto le opzioni la finestra mostra in tempo reale se il
trigger può scattare (*Right now: …*), utile per un controllo.

---

## 9. Avvia e guarda il lavoro

Premi **Start** sui rail **Struttura**, **Stile** e **Ricette**, uno alla
volta.

> Non usare **Run all**: avvia tutti i rail fermi che hanno qualcosa da
> fare, e quindi farebbe partire subito anche Integrazione, senza aspettare
> gli altri.

Cosa succede adesso:

- Ogni rail, al primo lancio, crea una **pagina sua** con il suo nome nella
  barra laterale. La pagina si apre in sottofondo: cliccala per vedere
  l'agente al lavoro nel suo terminale.
- Le card passano in **In Progress** sulla kanban. Quando un agente finisce,
  sposta la sua card in **Done** e il rail passa al passo successivo, il
  commit.
- Lo stato di ogni rail è nella sua intestazione: *idle*, *running* o
  *paused*. Se un rail ha bisogno di te compare il segnale **needs you**, e
  passandoci sopra il mouse leggi il motivo.
- Quando i tre rail hanno finito, Integrazione parte da solo: unisce i tre
  rami, fa collegare i file a Claude Code, lancia `sh check.sh` e si ferma
  sul passo **Manual review**.
- A quel punto apri `~/ricettario/index.html` nel browser e guarda il
  risultato. Se ti convince, premi **Skip and proceed** sul passo Manual
  review: il rail riparte e arriva la notifica.

Il tab **Decisions** raccoglie in un posto solo tutto ciò che aspetta te nel
workspace (domande degli agenti, revisioni manuali, card da approvare). Il
tab **Review** mostra, card per card, cosa ha cambiato ogni esecuzione.
Infine **⇧⌘A** ti porta alla prossima sessione che ti aspetta.

---

## 10. Quando un rail si ferma

Un rail in pausa con **needs you** spiega sempre il perché. I casi più
comuni:

| Cosa dice                                   | Cosa fare |
|---------------------------------------------|-----------|
| la card non è stata letta (*nobody has read this card's body yet*) | Apri la card, **Review…**, conferma, poi **Retry** sul passo. |
| l'agente ti sta chiedendo qualcosa (*the agent is asking you something*) | Vai al suo tab e rispondi. |
| il turno è finito ma la card non è in Done (*the agent's turn ended but the card is not in Done*) | Guarda il lavoro nel tab dell'agente. Se è fatto, sposta tu la card in Done (tasto destro, **Move to Done**) oppure premi **Mark done** sul passo. Se manca qualcosa, chiedilo all'agente nel suo tab. |
| l'agente si è interrotto per un errore (*the agent stopped because something broke*) | **Retry** sul passo, oppure riprendi la card dal suo menu. |
| è un passo di revisione manuale             | Controlla il lavoro, poi **Skip and proceed**. |
| *fallback agent is not set up*              | Una card usa un agente non ancora preparato in questo workspace: completa la finestra **Set up … as a fallback**. |

Sul singolo passo hai sempre **Retry**, **Mark done**, **Skip and proceed**
e **Remove from rail**. **Reset run state** nell'intestazione riporta il
rail allo stato iniziale.

Altri inciampi possibili:

- **L'agente non risulta trovato.** Torna al punto 2.1: o non è installato,
  o sta in una cartella che Gavin non conosce, e allora va messo il
  percorso completo in **Command** (Settings → Agents, oppure le
  impostazioni del workspace).
- **Il pannello Usage dice che non trova il login.** Il badge d'uso legge i
  dati di consumo dell'agente con un canale suo. Per Claude Code, su macOS,
  li prende dal Portachiavi, e la prima volta il sistema chiede il permesso.
  Se il badge non si legge, l'agente parte comunque: il problema riguarda
  solo il conteggio dei limiti. Per Antigravity il messaggio nomina ancora
  "Gemini CLI", perché Antigravity usa lo stesso canale.
- **Integrazione è partito troppo presto.** Il trigger è stato impostato con
  gli altri rail vuoti (vedi 8.3). Premi **Pause**, poi **Reset run
  state**, e riavvia nell'ordine giusto.

---

## 11. Andare oltre

Una volta visto il meccanismo, ci sono modi più rapidi per arrivarci:

- **Organize with agent…** (nella barra del tab Orchestration). Affida le
  card non assegnate a un agente che, con la skill gavin-orchestrate,
  costruisce da solo i rail, crea i worktree e mette gli strumenti al posto
  giusto. Su un singolo rail c'è **Reorganize with agent**.
- **Develop into a plan…** (menu della card in To Do, o la casella *Develop
  with agent on add* quando la crei). Parti da una riga di intenzione:
  l'agente ti fa qualche domanda e propone una checklist o delle card figlie,
  e non scrive niente finché non approvi.
- **Run on several agents…** Lo stesso compito su due-sei agenti insieme,
  ognuno nel suo worktree, affiancati su una pagina. Alla fine tieni il
  risultato migliore con **Keep this one**.
- **Complexity.** Ogni card può dichiarare quanto è difficile (da *trivial*
  a *intricate*). In Settings → Agents, sezione **Complexity**, colleghi
  ogni livello a un agente, un modello e un livello di effort: così una
  rinomina non consuma quanto un refactoring. Di base la tabella è vuota e
  tutte le card usano l'agente del workspace.
- **Tools.** Il tab omonimo raccoglie gli strumenti predefiniti (fra gli
  altri *Run tests*, *Push branch*, *Open a pull request*, *Wait for the pull
  request*, *Review this branch*, *Critical review*, *Start rail*) e quelli
  che crei tu: un prompt per l'agente, un comando, uno script.
- **Trigger a orario.** Nel tab Trigger di un rail, **At a date and time**
  lo fa partire una volta all'ora che scegli.
- **Group templates.** Una sequenza di strumenti che usi spesso (per esempio
  commit, push e pull request) si salva dal menu ⋯ del gruppo con **Save as
  template…** e si trascina su altri rail.

---

## 12. Dove si trova cosa

| Cerchi…                                 | Lo trovi… |
|-----------------------------------------|-----------|
| l'elenco dei workspace, e come crearne uno | **Gavin** in basso nella barra laterale, poi **+ New workspace…** |
| Kanban, Orchestration, Decisions, Review, PRD | l'icona a forma di casa (**Hub**) sulla riga del workspace, poi i tab in alto |
| la configurazione guidata               | tab **Home** del workspace, **Finish setting up this workspace** |
| agente, modello, effort, fallback, complexity | **Settings** → **Agents** (per tutta l'app), oppure l'ingranaggio **Workspace settings** (per un workspace solo) |
| un terminale con un agente, senza card  | su una pagina, l'icona del robot (**New agent tab**); la freccia accanto (**New agent tab with…**) fa scegliere l'agente |
| i consumi degli agenti                  | **Usage** in basso nella barra laterale |
| la prossima sessione che aspetta te     | **⇧⌘A** |

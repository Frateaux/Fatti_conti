# Fatti Conti – Pesate e Pro Forma

Web app (PWA) semplice e veloce per il commercio di formaggi: registra le pesate dei colli dal fornitore, calcola i totali per merce e produce **fatture pro forma** e **fatture generali riepilogative con acconti e saldo**, pronte per l'archiviazione su Google Drive.

Funziona direttamente da smartphone e tablet, **anche senza connessione internet**.

---

## Funzionalità principali

### 1. Pesate veloci (Ritiri)
- Per ogni collo si tocca la merce (es. *Pecorino*, *Caciotta*) e si scrive il peso.
- Tastierino numerico grande ottimizzato per smartphone.
- Calcolo automatico immediato: **colli totali**, **kg totali**, **importo per merce** (€/kg) e **totale documento**.
- Prezzo modificabile anche sul singolo ritiro (con opzione di aggiornare il listino).

### 2. Fattura pro forma per ritiro
- Genera il PDF con intestazione aziendale personalizzata, dati del fornitore, riepilogo merci e dettaglio di ciascun collo pesato.
- Quando il ritiro viene saldato, il PDF riporta automaticamente il timbro:
  > **SALDATA con fattura generale n. Gxx/xxxx del gg/mm/aaaa**

### 3. Conti fornitore e Fatture Generali
Per i fornitori che vengono saldati periodicamente o a scaglioni diversi:
- **Collegamento automatico o separato**: per impostazione predefinita ogni nuova pro forma entra nella fattura generale aperta del fornitore; tuttavia, se due ritiri devono essere pagati in momenti diversi, puoi scegliere direttamente alla creazione **"+ Crea nuova fattura generale separata"**.
- **Separa / Sposta in qualsiasi momento**: se due pro forma si trovano già nella stessa fattura generale, puoi toccare **"Separa / Sposta"** (dal dettaglio del conto o dalla singola pro forma) per creare subito una fattura generale distinta o spostare il ritiro in un altro conto aperto.
- **Acconti**: puoi annotare in qualsiasi momento gli acconti versati (data, importo, metodo/nota). L'app mostra sempre il **residuo effettivo da pagare**.
- **Registrazione del saldo**: inserendo la **data del saldo** e l'importo:
  - La fattura generale viene chiusa e bloccata con il proprio saldo.
  - Tutte le pro forma incluse vengono **bloccate definitivamente** per evitare modifiche accidentali.
  - Sulla fattura generale e su ciascuna pro forma viene registrato il riferimento al saldo.
  - Eventuali altre fatture generali dello stesso fornitore rimangono indipendenti e aperte fino al loro rispettivo saldo.

### 4. Report & Statistiche (Quadro Fornitori e Merci)
Analisi immediata e completa delle movimentazioni commerciali:
- **Filtri periodo flessibili**: Questo mese, Mese scorso, Anno in corso, Tutto lo storico o intervallo personalizzato con date Dal/Al.
- **KPI principali**: Totale speso (€), totale merce ritirata (kg), colli pesati e numero di ritiri, prezzo medio ponderato al kg (€/kg).
- **Quadro per Fornitore**: totale pagato ad ogni fornitore, quantità ritirata, **percentuale di spesa e peso sul totale** con barre grafiche e riepilogo dei formaggi forniti. Filtro opzionale per singolo fornitore con incidenza sul fatturato del periodo.
- **Quadro per Tipo di Merce**: quantità ritirata per ogni tipologia di formaggio, **percentuale sul peso e sulla spesa totale**, colli e prezzo medio di acquisto.
- **Andamento mensile**: tabella riassuntiva dei ritiri mese per mese quando il periodo selezionato copre più mesi.
- **Esportazione PDF e Condivisione**: download con un tocco o condivisione immediata del report tabellare professionale in formato PDF.

### 5. Sincronizzazione Cloud (Supabase, 100% gratuita e privata)
- **Tempo reale tra PC e Smartphone**: ogni dato inserito sul telefono compare automaticamente sul computer (e viceversa).
- **Crittografia e sicurezza RLS (Row Level Security)**: i dati sono protetti e accessibili solo ed esclusivamente dopo il login con la tua email e password. Nessuno su GitHub può visualizzarli.
- **Funzionamento offline preservato**: se non c'è connessione (es. in stalla o magazzino), l'app salva tutto localmente e sincronizza in background non appena il segnale ritorna.

### 6. Protezione & Blocco App (Impronta, Viso o PIN)
- **WebAuthn**: possibilità di bloccare l'apertura dell'applicazione con sensore biometrico (**Face ID**, **Impronta digitale** o **Windows Hello**).
- **PIN o Password di riserva**: per sbloccare l'app anche sui dispositivi sprovvisti di sensore biometrico.

### 7. Salvataggio su Google Drive
- Pulsante diretto **Salva PDF su Google Drive**: archivia i documenti nella cartella dedicata (con sottocartelle ordinate per fornitore).
- Possibilità di salvare in un colpo solo sia la fattura generale che tutte le singole pro forma incluse.
- Tasto di condivisione classica del telefono (WhatsApp, Drive, Email, Stampa) sempre disponibile come alternativa.

### 8. Utilizzo Offline (PWA)
- L'app salva tutti i file necessari nella memoria del dispositivo.
- Si apre e funziona regolarmente anche in stalla o in magazzino senza segnale.
- I dati inseriti restano memorizzati sul telefono e, appena torna la linea, i PDF possono essere inviati a Google Drive e il cloud si aggiorna da solo.
- In **Impostazioni** è sempre disponibile anche la funzione **Backup / Ripristino** manuale dei dati.

---

## Configurazione del Database Cloud Gratuito (Supabase)

1. Vai su [supabase.com](https://supabase.com) e registrati gratis (con email o account GitHub/Google).
2. Premi **New Project**, dagli un nome (es. `fatti-conti`) e imposta una password per il database.
3. Vai in **Project Settings** (icona ingranaggio) &rarr; **API**:
   - Copia il **Project URL** (es. `https://xyz.supabase.co`).
   - Copia la chiave **Project API keys** &rarr; `anon` `public`.
4. Vai nella sezione **SQL Editor** a sinistra, incolla ed esegui questo script di sicurezza:
   ```sql
   create table if not exists app_state (
     user_id uuid primary key references auth.users(id) on delete cascade,
     data jsonb not null,
     updated_at timestamptz not null default now()
   );

   alter table app_state enable row level security;

   create policy "Accesso riservato solo al proprietario"
     on app_state for all
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);
   ```
5. Nell'app, apri **Impostazioni** &rarr; inserisci l'URL e l'Anon Key, poi crea il tuo account con email e password. Fatto!

## Come installare l'app sul telefono

1. **Pubblica l'app** gratuitamente su **GitHub Pages**:
   - Carica questa cartella sul tuo account GitHub.
   - Vai in **Settings** > **Pages** > seleziona il branch `main` (cartella root `/`) e salva.
2. **Apri il link dallo smartphone**:
   - Su **Android** (Google Chrome): tocca il menu con i 3 puntini ⋮ e scegli **"Installa app"** o **"Aggiungi a schermata Home"**.
   - Su **iPhone** (Safari): tocca il pulsante Condividi in basso e scegli **"Aggiungi alla schermata Home"**.
3. L'app comparirà con la sua icona sul telefono e sarà pronta all'uso.

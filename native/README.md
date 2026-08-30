# FlowPilot — Módulo nativo (Android / Capacitor)

> **Importante:** este scaffold NÃO foi compilado/testado nesta máquina (sem Java/SDK aqui).
> É o ponto de partida para você buildar no **Android Studio** e ajustar aos detalhes do seu fluxo.
> Referências de pacote da 99: os textos/`package` devem ser conferidos na versão atual do app — o `com.taxis99` é histórico e pode mudar.

## Pillar 1 — fluxo de 2 estágios (Já no web)
A máquina de estados (`livre / embarque / viagem`), a transição automática por GPS (30 m)
e o aviso sonoro vivem em `app.js` (seção 16 + `window.FlowPilot`). **Não há captura manual**
na interface: os endereços só entram por injeção automática do serviço nativo.

## Pillar 2 — captura 100% automática dos endereços da 99
- `NotificationListenerService` intercepta as notificações da 99 e **classifica em 2 fases**:
  - **Nova corrida / aceite** → extrai o endereço de **Coleta** e injeta
    `?coleta=<endereço>` (estado EMBARQUE + rota). Empurrado via `acaoCaptura`.
  - **Início de viagem (slider)** → extrai o **Destino** e injeta
    `?viagem=1&destino=<endereço>` (estado DESTINO FINAL + rota).
- `MainActivity` traduz a `acaoCaptura` para **JS direto na WebView sem recarregar**
  (`FlowPilot.setEnderecoColeta/setEnderecoDestino/setDestinoFinal/embarcou/finalizar`),
  com fallback por URL (`?query`) para inicialização fria.
- Todo o restante (Coleta ➔ Viagem) é transitado pelo **GPS**: chegou a 30 m da coleta →
  transição automática (~6 s); chegou a 30 m do destino → encerramento automático (~15 s).
- **Único toque de emergência:** botão "Alternar Etapa" no widget flutuante, para quando
  o GPS não confirmar a chegada.

## Pillar 3 — GPS em segundo plano com COTADOR que não para
Requisito crítico: a contagem do odômetro e da troca de óleo **não pode ser interrompida**
enquanto o app estiver rodando — com tela apagada, celular bloqueado ou a 99/Uber em
primeiro plano. O `ForegroundLocationService` garante isto:

- **Fused Location com `PRIORITY_HIGH_ACCURACY`** — precisa adicionar no
  `android/app/build.gradle` das dependências:
  ```gradle
  implementation "com.google.android.gms:play-services-location:21.0.1"
  ```
  (sem ela, o serviço cai num fallback para o provider `GPS_PROVIDER` do sistema.)
- **Foreground service** do tipo `location`, usado com notificação fixa persistente na
  barra de status ("FlowPilot — EMBARQUE/EM VIAGEM | Odômetro: ... | Óleo: falta ...").
- **Partial WakeLock** (`flowpilot:gps`) impede o deep sleep da CPU enquanto conta.
- A cada tick, a distância é somada **direto no acumulador nativo** (`FlowBridge.somarKm`):
  odômetro total + Trip A/B, gravando continuamente a cada atualização.
- A troca de óleo usa a mesma base: `falta = intervalo - (total - trocaBase)`.
- O acumulador é **a fonte de verdade** quando o app roda; o `app.js` apenas espelha via
  `AndroidBridge.getStatus()` (evita contar o mesmo km duas vezes). Em PWA puro (browser),
  o web acumula sozinho como antes.
- `stopWithTask="false"` no manifest: descartar o app da lista recente não mata o serviço.

## Pillar 4 — overlay flutuante (sobre o app da 99)
- `OverlayService` + `SYSTEM_ALERT_WINDOW`: janela com velocidade, próxima manobra, ETA e botões
  [Alternar Etapa] [Abrir FlowPilot]. Desenha por cima de QUALQUER app (inclusive a 99),
  com `TYPE_APPLICATION_OVERLAY` no `WindowManager` — só existe dentro do APK compilado.

---

## Como buildar (na sua máquina, com Node + Android Studio)
1. `npm i -g @capacitor/cli` (ou use `npx cap`).
2. Instale o plugin de GPS de fundo:
   `npm i @capacitor-community/background-geolocation` (opcional).
3. `npx cap init "FlowPilot" "com.flowpilot.app" --web-dir .`
4. `npx cap add android` (cria `android/`).
5. Copie os arquivos deste diretório:
   - `AndroidManifest.xml` → mescle com `android/app/src/main/AndroidManifest.xml`
     (permissões, `intent-filter` de compartilhar, 3 serviços e o atributo principal em `MainActivity`).
   - `android/*.kt` → `android/app/src/main/java/com/flowpilot/app/`
     (classes: `MainActivity`, `NotificationListenerService`,
     `ForegroundLocationService`, `OverlayService`, `FlowBridge`).
6. `npx cap sync android`.
7. Abra `android/` no Android Studio e rode.
8. Permissão manual (1ª vez): Notificações → FlowPilot → "Acesso à notificação" (empacotador).
   Overlay: Configurações → Apps → FlowPilot → "Sobre outros apps".

## Compartilhando endereço via ACTION_SEND
Caminho alternativo (manual, via INTENT — não é usado na pista): o manifest declara o
handler `ACTION_SEND text/plain`; se outro app "compartilhar" um texto, ele é tratado como
destino. O caminho **recomendado e obrigatório para a pista** é o
`NotificationListenerService`, que lê a notificação da 99 e injeta sem nenhum toque.
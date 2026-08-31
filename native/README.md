# FlowPilot — Módulo nativo (Android / Capacitor)

> **Status:** o APK de debug **compila** (`android/app/build/outputs/apk/debug/app-debug.apk`).
> Ainda é "primeira versão": o texto/pacote da 99 devem ser conferidos na versão atual do app
> (`com.taxis99` é histórico e pode mudar).

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

## Como buildar (WIN — já validado nesta máquina)

O projeto já contém a plataforma gerada (`android/`) e **um build de debug real foi feito**
(`android/app/build/outputs/apk/debug/app-debug.apk`). Você precisa apenas de:

1. Node (para copiar a web) + Android Studio (ou JDK 21) + Android SDK (`C:\Android\Sdk`).
   - O Gradle do CLI precisa de **JDK 21** (o JBR 25 do Android Studio não roda com o
     Gradle 8.14.3): `winget install --id EclipseAdoptium.Temurin.21.JDK`.
2. Preparar o `www/` (o Capacitor 8 não aceita `webDir: "."`) e sincronizar assets:
   ```
   npm run sync:android
   ```
   (copia index/app/styles/sw/manifest/config.local.js/icons para `android/app/src/main/assets/public`).
3. Buildar o APK de debug:
   ```
   npm run apk
   ```
   → `android/app/build/outputs/apk/debug/app-debug.apk`. Ou abra a pasta `android/` no
   Android Studio e clique Run (deixe o Gradle JDK apontando para um JDK 21).

Stack de versões (fixadas e testadas): Gradle wrapper 8.14.3, AGP 8.13.0, Capacitor 8.5.0,
Kotlin plugin 2.1.0, `compileSdk 37` / `targetSdk 36` (plataforma `android-37.0` instalada),
`play-services-location:21.0.1`, `core-ktx` já nas dependências do app.

4. Instalar o APK no celular (Android Studio → Run, ou `adb install`):
   - 1ª vez: autorizar **localização "Permitir o tempo todo"**, **Exibir sobre outros apps**
     e **Acesso à notificação** (Settings → Apps → FlowPilot).
5. Configurar `config.local.js` com a chave TomTom (a mesma da web serve).

> Permissões GPS/USB: para testar, ative "Depuração USB" no celular e use `adb install
> app-debug.apk` (Android Debug Bridge, vem no `C:\Android\Sdk\platform-tools`).

## Compartilhando endereço via ACTION_SEND
Caminho alternativo (manual, via INTENT — não é usado na pista): o manifest declara o
handler `ACTION_SEND text/plain`; se outro app "compartilhar" um texto, ele é tratado como
destino. O caminho **recomendado e obrigatório para a pista** é o
`NotificationListenerService`, que lê a notificação da 99 e injeta sem nenhum toque.
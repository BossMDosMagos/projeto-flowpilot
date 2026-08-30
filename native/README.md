# FlowPilot — Módulo nativo (Android / Capacitor)

> **Importante:** este scaffold NÃO foi compilado/testado nesta máquina (sem Java/SDK aqui).
> É o ponto de partida para você buildar no **Android Studio** e ajustar aos detalhes do seu fluxo.
> Referências de pacote da 99: os textos/`package` devem ser conferidos na versão atual do app — o `com.taxis99` é histórico e pode mudar.

## Pillar 1 — fluxo de 2 estágios (Já no web)
A máquina de estados (`livre / embarque / viagem`), a captura de endereço e a proximidade de 30 m
com aviso sonoro vivem em `app.js` (seção 16 + `window.FlowPilot`). O app nativo apenas:
- injeta `window.AndroidBridge` na WebView para receber eventos e enviar links de captura;
- mantém a notificação fixa com o texto retornado por `FlowPilot.buscarStatus().textoNotificacao`.

## Pillar 2 — captura dos endereços da 99
- **ACTION_SEND**: o app pode ser aberto como "destino de um Compartilhar" da 99
  (`?coleta=<endereço>` / `?destino=<endereço>` são lidos no boot pelo web).
- **NotificationListenerService** (`BIND_NOTIFICATION_LISTENER_SERVICE`): lê notificações da 99,
  extrai texto com endereço e chama `corridaSetEndereco` pela ponte. (Mais confiável que compartilhar.)

## Pillar 3 — GPS em segundo plano
- `ForegroundLocationService`: serviço em primeiro plano com a notificação persistente
  "FlowPilot — [EMBARQUE/EM VIAGEM] / Odômetro: ... | Óleo: ...". Use
  `@capacitor-community/background-geolocation` **ou** o `GoogleApiClient`/`FusedLocationProviderClient`
  (o arquivo aqui ilustra o serviço; a coleta de localização em si fica a critério da lib escolhida).

## Pillar 4 — overlay flutuante (sobre o app da 99)
- `OverlayService` + `SYSTEM_ALERT_WINDOW`: janela com velocidade, próxima manobra, ETA e botões
  [Alternar Etapa] [+ Centralizar] [Abrir FlowPilot].

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

## Compartilhando endereço da 99 via ACTION_SEND
Manifest já declara o handler. Copiar link do FlowPilot (modal Configurações → Corrida) gera
`https://…/?coleta=<endereço>`; colar isso na 99 pode não funcionar como "share" —
o caminho recomendado é o **NotificationListenerService** que lê o endereço da notificação e injeta direto.
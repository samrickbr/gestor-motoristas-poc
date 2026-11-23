# Gestor de Motoristas — POC

Protótipo técnico do aplicativo mobile-first de controle financeiro para motoristas.

## Objetivo

Validar tecnologias e requisitos técnicos antes da implementação do produto.

## Stack atual

- React
- TypeScript
- Vite
- PWA com Manifest e Service Worker
- IndexedDB para persistência local

## Estado das provas de conceito

- POC-01: instalação e funcionamento offline — validada em iPhone e desktop.
- POC-02: persistência local com IndexedDB — validada em iPhone e Android Emulator.
- POC-03: diário financeiro local — domínio e persistência implementados. Operações e partidas são validadas e gravadas juntas no IndexedDB; valores são inteiros em centavos; há balanceamento por moeda, idempotência, diário append-only e estorno integral vinculado à operação original. A projeção técnica de valores pode ser reconstruída a partir das partidas.
- POC-04: outbox local — geração de eventos na mesma transação do diário, leitura de pendências e confirmação de eventos com cursor. O transporte disponível é simulado e não se conecta a um serviço remoto.
- POC-05: diagnóstico local de concorrência — interface para executar cenários com duas conexões IndexedDB e consultar a consistência dos dados persistidos. Os cenários acrescentam dados de demonstração ao diário local.

### Implementado

- Regras financeiras independentes da interface e do IndexedDB, incluindo validação das partidas e rejeição de operações desbalanceadas.
- Persistência atômica de operação, partidas e evento local da outbox; chave de idempotência única; proteção contra estorno integral duplicado.
- Reconstrução de uma projeção técnica por conta e moeda. Débitos são somados e créditos subtraídos; a natureza normal das contas ainda não foi definida, portanto a projeção não é um saldo financeiro definitivo.
- Código e testes para snapshots consistentes, serialização canônica, criptografia de backup e código de recuperação.

### Demonstrações simuladas

- A interface permite registrar receitas, despesas, transferências e estornos usando contas e valores de demonstração.
- Os controles da outbox simulam aceitação, timeout, falha, ACK inválido e lote parcial; não enviam dados pela rede.
- Os cenários de concorrência criam operações identificadas como POC-05 no IndexedDB deste navegador. Esses registros permanecem no diário; a demonstração não os apaga.
- As demonstrações não usam nem devem receber dados financeiros reais.

### Pendências

- Validar a POC-03 offline em iPhone e Android; a validação de dispositivos registrada para POC-01 e POC-02 não cobre esta implementação.
- Definir a interpretação financeira dos saldos e a natureza normal das contas antes de tratar a projeção técnica como saldo de produto.
- O transporte remoto, backend, sincronização com serviço externo e arquitetura definitiva não fazem parte desta POC.
- O fluxo de backup ainda não está integrado à interface de demonstração.

## Comandos

- `npm run dev`: desenvolvimento.
- `npm run build`: compilação de produção.
- `npm run lint`: análise estática.
- `npm test`: testes automatizados.
- `npm run preview`: visualizar build de produção.

## Limites

Este projeto é um protótipo descartável. Não utilizar dados financeiros reais, credenciais de produção ou serviços pagos.

A arquitetura definitiva do produto ainda depende da conclusão e aprovação da RIC-9 no Linear.

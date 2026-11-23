# AGENTS.md — Gestor de Motoristas POC

## 1. Papel do Codex

Atue como implementador técnico. O responsável pelo produto é o usuário; decisões de escopo e arquitetura pertencem a ele.

Antes de implementar:
- Leia este arquivo e o README.
- Inspecione a estrutura e o código existente.
- Apresente um plano curto, arquivos que pretende criar/alterar e estratégia de testes.
- Não comece alterações fora da tarefa explicitamente solicitada.

## 2. Contexto do projeto

Protótipo descartável em:
`E:\Projetos\gestor-motoristas-poc`

Projeto independente do SIGIN.

Stack existente:
- React
- TypeScript
- Vite
- PWA com Manifest e Service Worker manual
- IndexedDB

POC-01 e POC-02 foram validadas em dispositivos reais/emulador. Não recriar nem remover essas funcionalidades.

## 3. Escopo autorizado: POC-03

Implementar o núcleo local de um diário financeiro, com domínio independente da interface e do IndexedDB.

Requisitos:
- Operações financeiras e respectivas partidas contábeis.
- Valores BRL representados em centavos inteiros. Nunca usar ponto flutuante para valores monetários.
- Cada operação deve gerar partidas balanceadas por moeda.
- Diário append-only: operações confirmadas não podem ser editadas ou apagadas.
- Estorno deve gerar nova operação inversa, vinculada à original.
- Saldo deve ser uma projeção reconstruível a partir das partidas.
- Idempotência para impedir duplicação de operações.
- Persistência atômica da operação e de suas partidas em uma transação IndexedDB.

Cenários obrigatórios:
1. Receita de R$ 100,00.
2. Despesa de R$ 30,00.
3. Transferência de R$ 20,00 entre contas.
4. Rejeição de operação desbalanceada.
5. Estorno da receita.
6. Reconstrução de saldo após reinício.
7. Repetição da mesma chave de idempotência sem duplicação.

## 4. Sequência de implementação

1. Modelar o domínio financeiro sem dependência de React ou IndexedDB.
2. Implementar e testar as regras do diário.
3. Criar adaptador IndexedDB separado.
4. Garantir atomicidade entre operação e partidas.
5. Criar interface técnica mínima para demonstrar os cenários.
6. Validar funcionamento offline em iPhone e Android.

Não misturar regras financeiras com componentes visuais.

## 5. Restrições

Não fazer sem autorização específica:
- Firebase, Cloud Run, Supabase ou qualquer serviço remoto.
- API ou backend.
- Autenticação ou cadastro de usuários.
- Integração com pagamentos.
- Serviços pagos ou configuração de billing.
- Publicação em lojas.
- Alterações no SIGIN.
- Reestruturação geral do projeto.
- Escolha definitiva de arquitetura ou fornecedor.

Não adicionar dependências sem apresentar justificativa e solicitar aprovação.

Não alterar ou remover o comportamento validado da PWA, Service Worker e POC-02, salvo necessidade demonstrada e aprovada.

Não utilizar dados financeiros reais.

## 6. Qualidade e integridade

- TypeScript com tipagem explícita.
- Tratar erros de persistência e transações.
- Não converter valores monetários para ponto flutuante.
- Não permitir alteração ou exclusão de fatos financeiros confirmados.
- Garantir idempotência.
- Garantir balanceamento das partidas.
- Testes automatizados para os cenários definidos.
- Executar lint e build ao concluir.
- Não declarar testes aprovados sem apresentar os resultados.

## 7. Git e entregas

- Não executar commit, push, reset ou alteração de branch.
- Não apagar arquivos sem autorização.
- Manter alterações restritas ao protótipo.
- Ao concluir, apresentar:
  - resumo das mudanças;
  - arquivos criados e alterados;
  - decisões técnicas tomadas;
  - testes executados e resultados;
  - limitações e pendências;
  - comandos para validação manual.

## 8. Limite da autorização

A autorização atual cobre exclusivamente a POC-03 descrita neste documento.

A conclusão da POC não representa aprovação da arquitetura final, escolha de backend, fornecedor de nuvem ou autorização para iniciar o MVP comercial.

Decisões estruturais continuam condicionadas à aprovação do usuário e ao fechamento da RIC-9 no Linear.
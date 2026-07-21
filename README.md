# Gatekeep

## Webhook da Pluggy

Configure `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_WEBHOOK_URL` e
`PLUGGY_WEBHOOK_SECRET` no ambiente local. O mesmo valor de
`PLUGGY_WEBHOOK_SECRET` deve estar configurado no backend publicado.

Depois do deploy, registre ou atualize de forma idempotente o webhook `all`:

```bash
npm run pluggy:webhook:configure
```

O comando nunca exibe o segredo e mantém um único endpoint existente como alvo.
O cron da Vercel apenas recupera eventos já recebidos; a atualização automática
dos Items é executada pela própria Pluggy quando a aplicação está em Production.

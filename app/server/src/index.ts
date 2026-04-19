import express, { Request, Response } from 'express';

const app = express();
const PORT = 3000;

app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

export default app;

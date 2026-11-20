import { z } from 'zod';

export function tool<T extends z.ZodRawShape>(
  label: string, description: string, write: boolean, shape: T, destructive = false,
) {
  return { label, description, write, destructive, schema: z.strictObject(shape) };
}

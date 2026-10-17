import { z } from 'zod'

const vehicleSchema = z.object({
  code: z.string().trim().min(1).max(32),
  fuelConsumptionLitersPer100Km: z.number().finite().positive(),
  attributes: z.record(z.string(), z.string()).default({}),
  active: z.boolean().default(true)
}).strict()

const vehicleIdSchema = z.string().trim().min(1)

export { vehicleIdSchema, vehicleSchema }

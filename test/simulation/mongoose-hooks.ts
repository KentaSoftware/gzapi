import { expect } from 'chai'
import type { Schema } from 'mongoose'

function hasIndex (schema: Schema, fields: Record<string, 1 | -1>, unique = false): boolean {
  return schema.indexes().some(([indexFields, options]) => {
    return JSON.stringify(indexFields) === JSON.stringify(fields) && (unique ? options.unique === true : options.unique !== true)
  })
}

interface HookExecutor {
  execPre: (name: string, context: unknown, args: unknown[], callback: (error?: Error | null) => void) => void
}

async function executePreHook (schema: unknown, name: string, context: unknown): Promise<void> {
  const hooks = (schema as { s: { hooks: HookExecutor } }).s.hooks
  await new Promise<void>((resolve, reject) => {
    hooks.execPre(name, context, [], (error) => {
      if (error !== undefined && error !== null) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function expectHookRejection (schema: unknown, name: string, context: unknown): Promise<void> {
  let rejection: unknown
  try {
    await executePreHook(schema, name, context)
  } catch (error: unknown) {
    rejection = error
  }
  expect(rejection).to.be.instanceOf(Error)
}

export { hasIndex, executePreHook, expectHookRejection }

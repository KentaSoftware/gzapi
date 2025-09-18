import { Schema } from 'mongoose'

export function attachUpdatedBy (schema: Schema): void {
  schema.pre(['save', 'findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
    // @ts-ignore options context is not in types
    const userId = (this as any).options?.context?.userId
    if (userId) {
      try {
        // @ts-ignore set exists on query/doc
        this.set({ updatedBy: userId })
      } catch (_) {
        // ignore
      }
    }
    next()
  })
}



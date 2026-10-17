import { hash, compare } from 'bcrypt'

const encrypt = async (pass: string): Promise<string> => {
  const passwordHash = await hash(pass, 10)
  return passwordHash
}

const verified = async (pass: string, passHash: string): Promise<boolean> => {
  const isCorrect = await compare(pass, passHash)
  return isCorrect
}

export { encrypt, verified }

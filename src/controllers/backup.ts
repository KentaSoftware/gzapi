import { Request, Response } from 'express'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs'
/* import { handleHttp } from '../utils/error.handle'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket' */

const backupCtrl = async (_: Request, res: Response): Promise<void> => {
  const BACKUP_URI = process.env.BACKUP_URI as string
  const USER = process.env.USER as string
  const PASS = process.env.PASS as string
  const backupPath = path.join(__dirname, '../../backups') // Ruta absoluta a la carpeta backups

  // Verificar si la carpeta de backups existe, si no, crearla
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true })
  }

  exec(`mongodump --uri="${BACKUP_URI}" --out=${backupPath} --username="${USER}" --password="${PASS}"`, (error: any, _stdout: any, stderr: any) => {
    if (error != null) {
      console.error(`Error: ${error.message}`)
      return res.status(500).send('Error generando el backup')
    }

    // Filtrar mensajes de stderr que no son errores reales
    if (stderr != null && stderr !== '' && String(stderr).toLowerCase().includes('error')) {
      console.error(`stderr: ${stderr}`)
      return res.status(500).send('Error generando el backup')
    }
    return res.send('Backup generado exitosamente')
  })
}

const restoreCtrl = async (_: Request, res: Response): Promise<void> => {
  const BACKUP_URI = process.env.BACKUP_URI as string
  const USER = process.env.USER as string
  const PASS = process.env.PASS as string
  const backupPath = path.join(__dirname, '../../backups/test') // Ruta absoluta a la carpeta donde están los backups

  // Verificar si el directorio de backups existe
  if (!fs.existsSync(backupPath)) {
    res.status(404).send('No se encontró el directorio de backups')
    return
  }

  exec(`mongorestore --uri="${BACKUP_URI}" --username="${USER}" --password="${PASS}" --drop --nsInclude=test.* ${backupPath}`, (error: any, _stdout: any, stderr: any) => {
    if (error != null) {
      console.error(`Error: ${error.message}`)
      return res.status(500).send('Error restaurando el backup')
    }

    // Filtrar mensajes de stderr que no son errores reales
    if (stderr != null && stderr !== '' && String(stderr).toLowerCase().includes('error')) {
      console.error(`stderr: ${stderr}`)
      return res.status(500).send('Error restaurando el backup')
    }
    return res.send('Backup restaurado exitosamente')
  })
}

export { backupCtrl, restoreCtrl }

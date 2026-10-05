import { fromZonedTime } from 'date-fns-tz'
import { Types } from 'mongoose'
import { Client, GEOCODING_STATUS } from '../interfaces/client.interface'
import {
  CANDIDATE_BLOCK_REASONS,
  CandidateEntry,
  CandidateQuery,
  CandidateResult,
  BlockedCandidateEntry
} from '../interfaces/routeOptimization.interface'
import ClientModel from '../models/client'
import SaleModel from '../models/sale'

const CANDIDATE_RULE_VERSION = 'candidate-eligibility-v1'
const SERVICE_TIME_ZONE = 'America/Argentina/Buenos_Aires'

const serviceDateRange = (serviceDate: string): { start: Date, end: Date } => {
  const [year, month, day] = serviceDate.split('-').map(Number)
  const nextCivilDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)

  return {
    start: fromZonedTime(`${serviceDate}T00:00:00`, SERVICE_TIME_ZONE),
    end: fromZonedTime(`${nextCivilDate}T00:00:00`, SERVICE_TIME_ZONE)
  }
}

const candidateEntry = (saleId: unknown, client: Client): CandidateEntry => ({
  saleId: String(saleId),
  clientId: String(client._id),
  displayName: client.nombreCompleto,
  addressSummary: client.address
})

const blockedCandidate = (saleId: unknown, reason: BlockedCandidateEntry['reasons'][number], client?: Client): BlockedCandidateEntry => {
  const result: BlockedCandidateEntry = { saleId: String(saleId), reasons: [reason] }
  if (client !== undefined) {
    result.clientId = String(client._id)
    result.displayName = client.nombreCompleto
    result.addressSummary = client.address
  }
  return result
}

const getCandidates = async ({ serviceDate, deliveryZoneId }: CandidateQuery): Promise<CandidateResult> => {
  const { start, end } = serviceDateRange(serviceDate)
  const sales = await SaleModel.find({
    'delivery.status': 'PENDING',
    'delivery.serviceDate': { $gte: start, $lt: end }
  })
    .sort({ _id: 1 })
    .lean()

  const clientIds = sales
    .map((sale) => sale.idCliente === undefined ? undefined : String(sale.idCliente))
    .filter((id): id is string => id !== undefined && Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id))
  const clients = await ClientModel.find({ _id: { $in: clientIds } }).lean()
  const clientsById = new Map(clients.map((client) => [String(client._id), client]))

  const requestedZoneId = new Types.ObjectId(deliveryZoneId)
  const eligible: CandidateEntry[] = []
  const blocked: BlockedCandidateEntry[] = []

  for (const sale of sales) {
    const client = sale.idCliente === undefined ? undefined : clientsById.get(String(sale.idCliente))
    if (client === undefined) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.INVALID_CLIENT_REFERENCE))
    } else if (client.isActive !== true) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_INACTIVE, client))
    } else if (client.deliveryZoneId === undefined || !requestedZoneId.equals(client.deliveryZoneId)) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_ZONE_MISMATCH, client))
    } else if (client.address === undefined || client.address.trim() === '' || client.lat === undefined || client.lng === undefined) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_MISSING, client))
    } else if (client.geocoding?.status !== GEOCODING_STATUS.CONFIRMED) {
      blocked.push(blockedCandidate(sale._id, CANDIDATE_BLOCK_REASONS.CLIENT_LOCATION_UNCONFIRMED, client))
    } else {
      eligible.push(candidateEntry(sale._id, client))
    }
  }

  return { eligible, blocked, ruleVersion: CANDIDATE_RULE_VERSION }
}

export { CANDIDATE_RULE_VERSION, getCandidates }

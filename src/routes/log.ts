import { Router } from "express"
import { checkJwt } from "../middleware/session"
import { getItems } from "../controllers/log"
import { checkPermission } from "../middleware/checkPermission"

const router = Router()

router.post('/', checkJwt, checkPermission('read_log'), getItems)

export { router }
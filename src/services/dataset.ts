
import BuyModel from '../models/buy'
import ItemSaleModel from '../models/itemSale'
import SaleModel from '../models/sale'
import { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, addDays, addWeeks, addMonths, addYears, addHours } from 'date-fns'

interface Response {
  totalSales: number
  salesCount: number
  label: string
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getDailyData = async (): Promise<Response[]> => {
  const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const start = addHours(startOfDay(today), 3)
  const end = addHours(endOfDay(today), 3)
  const todayIndex = (today.getDay() + 6) % 7
  const startBefore = new Date(start);
  startBefore.setDate(startBefore.getDate() - 1);

  const endBefore = new Date(end);
  endBefore.setDate(endBefore.getDate() - 1);

  const day = String(today.getDate()).padStart(2, '0') // Asegura que el día tenga 2 dígitos
  const month = String(today.getMonth() + 1).padStart(2, '0') // Los meses en JavaScript van de 0 a 11
  const formattedDate = `${days[todayIndex]} ${day}-${month}`


  const responseSale = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseSaleBefore = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: startBefore,
          $lte: endBefore
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseBuy = await BuyModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  return [
    responseSale[0] ? {
      ...responseSale[0],
      label: 'sale',
      id: 0,
      date: formattedDate,
      totalSalesDifference: responseSaleBefore[0] ? `${(((responseSale[0].totalSales - responseSaleBefore[0].totalSales) / responseSaleBefore[0].totalSales) * 100).toFixed(2)}` : 0,
      salesCountDifference: responseSaleBefore[0] ? `${(((responseSale[0].salesCount - responseSaleBefore[0].salesCount) / responseSaleBefore[0].salesCount) * 100).toFixed(2)}` : 0
    } :
      { totalSales: 0, salesCount: 0, label: 'sale', id: 0, date: formattedDate, totalSalesDifference: 0, salesCountDifference: 0 },
    responseBuy[0] ? { ...responseBuy[0], label: 'buy', id: 1, date: formattedDate } : { totalSales: 0, salesCount: 0, label: 'buy', id: 1, date: formattedDate }
  ]
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getWeeklyData = async (): Promise<Response[]> => {
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const start = addHours(startOfWeek(today), 27)
  const end = addHours(endOfWeek(today), 27)

  const startBefore = new Date(start);
  startBefore.setDate(startBefore.getDate() - 7);

  const endBefore = new Date(end);
  endBefore.setDate(endBefore.getDate() - 7);

  const dayStart = String(start.getDate()).padStart(2, '0')
  const monthStart = String(start.getMonth() + 1).padStart(2, '0')

  const dayEnd = String(end.getDate()).padStart(2, '0')
  const monthEnd = String(end.getMonth() + 1).padStart(2, '0')

  const interval = `${dayStart + '-' + monthStart + ' a ' + dayEnd + '-' + monthEnd}`

  const responseSale = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseSaleBefore = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: startBefore,
          $lte: endBefore
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseBuy = await BuyModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const rpSale = {
    ...responseSale[0],
    label: 'sale',
    id: 0,
    date: interval,
    totalSalesDifference: `${(((responseSale[0].totalSales - responseSaleBefore[0].totalSales) / responseSaleBefore[0].totalSales) * 100).toFixed(2)}`,
    salesCountDifference: `${(((responseSale[0].salesCount - responseSaleBefore[0].salesCount) / responseSaleBefore[0].salesCount) * 100).toFixed(2)}`
  }

  return [
    responseSale[0] ? { ...rpSale } : { totalSales: 0, salesCount: 0, label: 'sale', id: 0, date: interval },
    responseBuy[0] ? { ...responseBuy[0], label: 'buy', id: 1, date: interval } : { totalSales: 0, salesCount: 0, label: 'buy', id: 1, date: interval }
  ]
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getMonthlyData = async (): Promise<Response[]> => {
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const start = addHours(startOfMonth(today), 3)
  const end = addHours(endOfMonth(today), 3)

  const startBefore = new Date(start);
  startBefore.setMonth(startBefore.getMonth() - 1);

  const endBefore = new Date(end);
  endBefore.setMonth(endBefore.getMonth() - 1)

  const month = String(today.getMonth())
  const year = String(today.getFullYear())
  const interval = `${months[parseFloat(month)] + ' del ' + year}`

  const responseSale = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseSaleBefore = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: startBefore,
          $lte: endBefore
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseBuy = await BuyModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const rpSale = {
    ...responseSale[0],
    label: 'sale',
    id: 0,
    date: interval,
    totalSalesDifference: `${(((responseSale[0].totalSales - responseSaleBefore[0].totalSales) / responseSaleBefore[0].totalSales) * 100).toFixed(2)}`,
    salesCountDifference: `${(((responseSale[0].salesCount - responseSaleBefore[0].salesCount) / responseSaleBefore[0].salesCount) * 100).toFixed(2)}`
  }

  return [
    responseSale[0] ? { ...rpSale } : { totalSales: 0, salesCount: 0, label: 'sale', id: 0, date: interval },
    responseBuy[0] ? { ...responseBuy[0], label: 'buy', id: 1, date: interval } : { totalSales: 0, salesCount: 0, label: 'buy', id: 1, date: interval }
  ]
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getAnnuallyData = async (): Promise<Response[]> => {
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const start = addHours(startOfYear(today), 3)
  const end = addHours(endOfYear(today), 3)

  const startBefore = new Date(start);
  startBefore.setFullYear(startBefore.getFullYear() - 1);

  const endBefore = new Date(end);
  endBefore.setFullYear(endBefore.getFullYear() - 1);

  /* const dayStart = String(start.getDate()).padStart(2, '0')
  const monthStart = String(start.getMonth() + 1).padStart(2, '0')

  const dayEnd = String(end.getDate()).padStart(2, '0')
  const monthEnd = String(end.getMonth() + 1).padStart(2, '0') */

  const year = String(today.getFullYear())

  /* const interval = `${dayStart + '-' + monthStart + ' a ' + dayEnd + '-' + monthEnd}` */

  const responseSale = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseSaleBefore = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: startBefore,
          $lte: endBefore
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseBuy = await BuyModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: start,
          $lte: end
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const rpSale = {
    ...responseSale[0],
    label: 'sale',
    id: 0,
    date: year,
    totalSalesDifference: `${(((responseSale[0].totalSales - responseSaleBefore[0].totalSales) / responseSaleBefore[0].totalSales) * 100).toFixed(2)}`,
    salesCountDifference: `${(((responseSale[0].salesCount - responseSaleBefore[0].salesCount) / responseSaleBefore[0].salesCount) * 100).toFixed(2)}`
  }

  return [
    responseSale[0] ? { ...rpSale } : { totalSales: 0, salesCount: 0, label: 'sale', id: 0, date: year },
    responseBuy[0] ? { ...responseBuy[0], label: 'buy', id: 1, date: year } : { totalSales: 0, salesCount: 0, label: 'buy', id: 1, date: year }
  ]
}

const getCustomData = async (start: string, end: string): Promise<Response[]> => {

  const startDate = new Date(start);
  const endDate = new Date(end);

  const clearStartDate = addHours(startOfDay(startDate), 3);
  const clearEndDate = addHours(endOfDay(endDate), 3);

  // Calcular la diferencia de días (en valor absoluto)
  const differenceInMilliseconds = Math.abs(clearEndDate.getTime() - clearStartDate.getTime());
  const differenceInDays = differenceInMilliseconds / (1000 * 60 * 60 * 24);

  // Calcular las fechas anteriores
  const startBefore = new Date(clearStartDate);
  startBefore.setDate(startBefore.getDate() - differenceInDays);

  const endBefore = new Date(clearEndDate);
  endBefore.setDate(endBefore.getDate() - differenceInDays);

  const dayStart = String(clearStartDate.getDate()).padStart(2, '0')
  const monthStart = String(clearStartDate.getMonth() + 1).padStart(2, '0')

  const dayEnd = String(clearEndDate.getDate()).padStart(2, '0')
  const monthEnd = String(clearEndDate.getMonth() + 1).padStart(2, '0')


  const interval = `${dayStart + '-' + monthStart + ' a ' + dayEnd + '-' + monthEnd}`

  const responseSale = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: clearStartDate,
          $lte: clearEndDate
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseSaleBefore = await SaleModel.aggregate([
    {
      $match: {
        estado: { $ne: 'Cancelado' },
        createdAt: {
          $gte: startBefore,
          $lte: endBefore
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const responseBuy = await BuyModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: clearStartDate,
          $lte: clearEndDate
        }
      }
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$total' },
        salesCount: { $sum: 1 }
      }
    }
  ])

  const rpSale = {
    ...responseSale[0],
    label: 'sale',
    id: 0,
    date: interval,
    totalSalesDifference: `${(((responseSale[0].totalSales - responseSaleBefore[0].totalSales) / responseSaleBefore[0].totalSales) * 100).toFixed(2)}`,
    salesCountDifference: `${(((responseSale[0].salesCount - responseSaleBefore[0].salesCount) / responseSaleBefore[0].salesCount) * 100).toFixed(2)}`
  }

  return [
    responseSale[0] ? { ...rpSale } : { totalSales: 0, salesCount: 0, label: 'sale', id: 0, date: interval },
    responseBuy[0] ? { ...responseBuy[0], label: 'buy', id: 1, date: interval } : { totalSales: 0, salesCount: 0, label: 'buy', id: 1, date: interval }
  ]
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getDailyDataGraph = async (): Promise<any> => {
  const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const todayIndex = (today.getDay() + 6) % 7 // Ajuste para que el lunes sea el día 0, martes el día 1, y así sucesivamente.

  /* const sales = []
  const buy = [] */
  const data = []

  for (let i = 0; i < 7; i++) {
    const dayIndex = (todayIndex - todayIndex + i + 7) % 7 // Mantener el cálculo del índice
    const dayOfWeek = addDays(today, i - todayIndex) // Calcula la fecha correspondiente al día de la semana

    const start = addHours(startOfDay(dayOfWeek), 3)
    const end = addHours(endOfDay(dayOfWeek), 3)

    const responseSale = await SaleModel.aggregate([
      { $match: { estado: { $ne: 'Cancelado' }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    const responseBuy = await BuyModel.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    /* sales.push({
      id: i,
      label: days[dayIndex], // Asignación correcta del día de la semana
      totalSales: responseSale[0]?.totalSales || 0,
      salesCount: responseSale[0]?.salesCount || 0
    })

    buy.push({
      id: i,
      label: days[dayIndex], // Asignación correcta del día de la semana
      totalSales: responseBuy[0]?.totalSales || 0,
      salesCount: responseBuy[0]?.salesCount || 0
    }) */

    data.push({
      id: i,
      label: days[dayIndex],
      compras: responseBuy[0]?.totalSales || 0,
      ventas: responseSale[0]?.totalSales || 0
    })
  }

  return { data }
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getWeeklyDataGraph = async (): Promise<any> => {
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const currentMonth = today.getMonth() // Mes actual (0 para enero, 11 para diciembre)

  /* const sales = []
  const buy = [] */
  const data = []

  for (let i = 0; i < 4; i++) { // Intentando obtener datos de las últimas 4 semanas
    const start = addHours(startOfWeek(addWeeks(today, -i), { weekStartsOn: 1 }), 3)
    const end = addHours(endOfWeek(addWeeks(today, -i), { weekStartsOn: 1 }), 3)

    const dayStart = String(start.getDate()).padStart(2, '0')
    const monthStart = String(start.getMonth() + 1).padStart(2, '0')

    const dayEnd = String(end.getDate()).padStart(2, '0')
    const monthEnd = String(end.getMonth() + 1).padStart(2, '0')

    const interval = `${dayStart + '-' + monthStart + ' a ' + dayEnd + '-' + monthEnd}`

    // Verificar si la semana pertenece al mismo mes
    if (start.getMonth() !== currentMonth) {
      break // Detener el ciclo si la semana no pertenece al mes actual
    }

    const responseSale = await SaleModel.aggregate([
      { $match: { estado: { $ne: 'Cancelado' }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    const responseBuy = await BuyModel.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    data.push({
      id: i,
      label: interval,
      compras: responseBuy[0]?.totalSales || 0,
      ventas: responseSale[0]?.totalSales || 0
    })

    /* sales.push({
      id: i,
      label: interval,
      totalSales: responseSale[0]?.totalSales || 0,
      salesCount: responseSale[0]?.salesCount || 0
    })

    buy.push({
      id: i,
      label: interval,
      totalSales: responseBuy[0]?.totalSales || 0,
      salesCount: responseBuy[0]?.salesCount || 0
    }) */
  }

  return { data }
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getMonthlyDataGraph = async (): Promise<any> => {
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  const today = new Date()
  today.setHours(today.getHours() - 3)
  const currentYear = today.getFullYear() // Año actual

  /*  const sales = []
   const buy = [] */
  const data = []

  for (let i = 0; i < 12; i++) { // Intentando obtener datos de los últimos 12 meses
    const start = addHours(startOfMonth(addMonths(today, -i)), 3)
    const end = addHours(endOfMonth(addMonths(today, -i)), 3)

    // Verificar si el mes pertenece al mismo año
    if (start.getFullYear() !== currentYear) {
      break // Detener el ciclo si el mes no pertenece al año actual
    }

    const responseSale = await SaleModel.aggregate([
      { $match: { estado: { $ne: 'Cancelado' }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    const responseBuy = await BuyModel.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    data.push({
      id: i,
      label: months[start.getMonth()],
      compras: responseBuy[0]?.totalSales || 0,
      ventas: responseSale[0]?.totalSales || 0
    })

    data.sort((a, b) => {
      const monthA = months.indexOf(a.label)
      const monthB = months.indexOf(b.label)
      return monthA - monthB
    })

    /* sales.push({
      id: i,
      label: months[start.getMonth()],
      totalSales: responseSale[0]?.totalSales || 0,
      salesCount: responseSale[0]?.salesCount || 0
    })

    buy.push({
      id: i,
      label: months[start.getMonth()],
      totalSales: responseBuy[0]?.totalSales || 0,
      salesCount: responseBuy[0]?.salesCount || 0
    }) */
  }

  // Ordenar los datos por mes en orden ascendente
  /* sales.sort((a, b) => {
    const monthA = months.indexOf(a.label)
    const monthB = months.indexOf(b.label)
    return monthA - monthB
  })

  buy.sort((a, b) => {
    const monthA = months.indexOf(a.label)
    const monthB = months.indexOf(b.label)
    return monthA - monthB
  }) */

  return { data }
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getAnnuallyDataGraph = async (): Promise<any> => {
  const today = new Date()
  today.setHours(today.getHours() - 3)
  /* const sales = []
  const buy = [] */
  const data = []

  for (let i = 0; i < 5; i++) { // Obteniendo datos de los últimos 5 años
    const start = addHours(startOfYear(addYears(today, -i)), 3)
    const end = addHours(endOfYear(addYears(today, -i)), 3)

    const responseSale = await SaleModel.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    const responseBuy = await BuyModel.aggregate([
      { $match: { createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ])

    data.push({
      id: i,
      label: `${start.getFullYear()}`,
      compras: responseBuy[0]?.totalSales || 0,
      ventas: responseSale[0]?.totalSales || 0
    })

    data.sort((a, b) => parseInt(a.label) - parseInt(b.label))

    /* sales.push({
      id: i,
      label: `${start.getFullYear()}`,
      totalSales: responseSale[0]?.totalSales || 0,
      salesCount: responseSale[0]?.salesCount || 0
    })

    buy.push({
      id: i,
      label: `${start.getFullYear()}`,
      totalSales: responseBuy[0]?.totalSales || 0,
      salesCount: responseBuy[0]?.salesCount || 0
    }) */
  }

  // Ordenar los datos por año en orden ascendente
  /* sales.sort((a, b) => parseInt(a.label) - parseInt(b.label))
  buy.sort((a, b) => parseInt(a.label) - parseInt(b.label)) */

  return { data }
}

// Modelos usados: SaleModel (no usa ItemSaleModel)
const getCustomDataGraph = async (start: string, end: string): Promise<any> => {
  const startDate = new Date(start);
  const endDate = new Date(end);

  // Limpiar las fechas para el cálculo
  const clearStartDate = addHours(startOfDay(startDate), 3);
  const clearEndDate = addHours(endOfDay(endDate), 3);

  /* const sales = [];
  const buy = []; */
  const data = []

  // Obtener los días en el rango de fechas
  const currentDate = clearStartDate;
  const endLoopDate = clearEndDate;

  while (currentDate <= endLoopDate) {
    const dayLabel = currentDate.toLocaleDateString('es-ES', { weekday: 'long' }); // Obtener el nombre del día en español
    const day = String(currentDate.getDate()).padStart(2, '0') // Asegura que el día tenga 2 dígitos
    const month = String(currentDate.getMonth() + 1).padStart(2, '0') // Los meses en JavaScript van de 0 a 11
    const formattedDate = `${dayLabel} ${day}-${month}`

    const startDay = addHours(startOfDay(currentDate), 3)
    const endDay = addHours(endOfDay(currentDate), 3)

    // Realizar la consulta de ventas
    const responseSale = await SaleModel.aggregate([
      { $match: { estado: { $ne: 'Cancelado' }, createdAt: { $gte: startDay, $lte: endDay } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ]);

    // Realizar la consulta de compras
    const responseBuy = await BuyModel.aggregate([
      { $match: { createdAt: { $gte: startDay, $lte: endDay } } },
      { $group: { _id: null, totalSales: { $sum: '$total' }, salesCount: { $sum: 1 } } }
    ]);

    data.push({
      label: formattedDate,
      compras: responseBuy[0]?.totalSales || 0,
      ventas: responseSale[0]?.totalSales || 0
    })

    data.sort((a, b) => parseInt(a.label) - parseInt(b.label))

    // Agregar datos de ventas
    /* sales.push({
      id: sales.length,
      label: formattedDate,
      totalSales: responseSale[0]?.totalSales || 0,
      salesCount: responseSale[0]?.salesCount || 0,
    });

    // Agregar datos de compras
    buy.push({
      id: buy.length,
      label: formattedDate,
      totalSales: responseBuy[0]?.totalSales || 0,
      salesCount: responseBuy[0]?.salesCount || 0,
    });
 */
    // Avanzar al siguiente día
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return { data };
};

// Modelos usados: ItemSaleModel (no usa SaleModel)
const bestSelling = async (): Promise<any[]> => {
  const productosMasVendidos = await ItemSaleModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: new Date('2024-09-01T00:00:00.000Z'), // Inicio de septiembre
          $lt: new Date('2024-10-01T00:00:00.000Z') // Inicio de octubre
        },
        estado: true
      }
    },
    {
      $group: {
        _id: '$idProducto', // Agrupamos por idProducto
        totalCantidad: { $sum: '$cantidad' } // Sumar el total de cantidad
      }
    },
    {
      $lookup: {
        from: 'products', // Unimos con la colección de productos
        localField: '_id', // idProducto en ItemSale
        foreignField: '_id', // _id del producto en Product
        as: 'productoInfo' // Información del producto se almacena en productoInfo
      }
    },
    {
      $unwind: '$productoInfo' // Descomponemos el array de productoInfo
    },
    {
      $project: {
        _id: 0, // Excluimos el _id de la respuesta
        producto: '$productoInfo.descripcion', // Nombre del producto
        totalCantidad: 1 // Mantenemos totalCantidad
      }
    },
    {
      $sort: {
        totalCantidad: -1 // Ordenamos por la cantidad más alta primero
      }
    }
  ])

  return productosMasVendidos
}

// Modelos usados: ItemSaleModel (no usa SaleModel)
const highProfit = async (): Promise<any[]> => {
  const productosQueGeneranMasDinero = await ItemSaleModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: new Date('2024-09-01T00:00:00.000Z'), // Inicio de septiembre
          $lt: new Date('2024-10-01T00:00:00.000Z') // Inicio de octubre
        },
        estado: true
      }
    },
    {
      $group: {
        _id: '$idProducto', // Agrupamos por idProducto
        totalGenerado: { $sum: '$total' } // Sumar el total generado en dinero
      }
    },
    {
      $lookup: {
        from: 'products', // Unimos con la colección de productos
        localField: '_id', // idProducto en ItemSale
        foreignField: '_id', // _id del producto en Product
        as: 'productoInfo' // Información del producto se almacena en productoInfo
      }
    },
    {
      $unwind: '$productoInfo' // Descomponemos el array de productoInfo
    },
    {
      $project: {
        _id: 0, // Excluimos el _id de la respuesta
        producto: '$productoInfo.descripcion', // Nombre del producto
        totalGenerado: 1 // Mantenemos totalGenerado
      }
    },
    {
      $sort: {
        totalGenerado: -1 // Ordenamos por el total generado más alto primero
      }
    }
  ])

  return productosQueGeneranMasDinero
}

// Modelos usados: ItemSaleModel (no usa SaleModel)
const dataProduct = async (): Promise<any[]> => {
  const productosConMasGanancia = await ItemSaleModel.aggregate([
    {
      $match: {
        createdAt: {
          $gte: new Date('2024-09-01T00:00:00.000Z'), // Inicio de septiembre
          $lt: new Date('2024-10-01T00:00:00.000Z') // Inicio de octubre
        },
        estado: true
      }
    },
    {
      $group: {
        _id: '$idProducto', // Agrupamos por idProducto
        totalVentas: { $sum: '$total' }, // Sumamos el total generado
        totalCantidad: { $sum: '$cantidad' } // Sumamos la cantidad vendida
      }
    },
    {
      $lookup: {
        from: 'products', // Unimos con la colección de productos
        localField: '_id', // idProducto en ItemSale
        foreignField: '_id', // _id del producto en Product
        as: 'productoInfo' // Información del producto en productoInfo
      }
    },
    {
      $unwind: '$productoInfo' // Descomponemos el array de productoInfo
    },
    {
      $addFields: {
        ganancia: {
          $subtract: [
            '$totalVentas',
            { $multiply: ['$totalCantidad', '$productoInfo.precioCompra'] } // Fórmula de ganancia
          ]
        }
      }
    },
    {
      $project: {
        _id: 1, // Excluimos el _id de la respuesta
        /* idProducto: 1, */
        producto: '$productoInfo.descripcion', // Nombre del producto
        totalVentas: 1, // Mantenemos totalVentas
        totalCantidad: 1, // Mantenemos totalCantidad
        ganancia: 1 // Mantenemos la ganancia
      }
    },
    {
      $sort: {
        ganancia: -1 // Ordenamos por mayor ganancia primero
      }
    }
  ])

  return productosConMasGanancia
}

export {
  getDailyData, getWeeklyData, getMonthlyData, getAnnuallyData, getDailyDataGraph, getWeeklyDataGraph, getMonthlyDataGraph, getAnnuallyDataGraph,
  bestSelling, highProfit, dataProduct, getCustomData, getCustomDataGraph
}

import { Types } from 'mongoose'
import { Brand } from '../interfaces/product.interface'
import BrandModel from '../models/brand'

const insertBrand = async (item: Brand): Promise<Brand> => {
  const responseInsert = await BrandModel.create(item)
  return responseInsert
}

const getBrands = async (): Promise<Brand[]> => {
  const response = await BrandModel.find({})
  return response
}

const getBrand = async (id: Types.ObjectId): Promise<any> => {
  const response = await BrandModel.find({ _id: id })
  return response
}

const updateBrand = async (id: Types.ObjectId, item: Brand): Promise<any> => {
  const response = await BrandModel.updateOne({ _id: id }, { $set: item })
  return response
}

export { getBrand, getBrands, insertBrand, updateBrand }

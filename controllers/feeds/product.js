const Shopify = require('shopify-api-node')
const fs = require('fs')
const Client = require('ssh2-sftp-client')
const TaxCodeList = require('../../config/constants').TaxCodeList
const ProductTypeList = require('../../config/constants').ProductTypeList
const TaxonomyList = require('../../config/constants').TaxonomyList
const delay = require('delay')
const TSV = require('tsv')

const Vendor = require('../../models/Vendor')
const Connector = require('../../models/Connector')
const commonHelper = require('../../helpers/common')


/**
 * GET /
 * Product page.
 */
exports.index = async (req, res, next) => {

    var vendorInfo
    var connectorInfo
    var productFileName = ''
    var shopify = null
    var metaList
    var errorExist = false
    
    Vendor.findOne({
        _id: req.user.vendorId
    }, (vendorError, vendor) => {
        if (vendorError) {
            return next(vendorError)
        }
        vendorInfo = vendor
        productFileName = 'uploads/product-' + vendor.api.apiShop + '.txt'

        if (vendorInfo.api.apiShop == '' || vendorInfo.api.apiKey == '' || vendorInfo.api.apiPassword == '') {
            req.flash('errors', {
                msg: 'You should have API information to manage product feed. Please contact with Administrator.'
            })
            errorExist = true
            res.redirect('/')
            return next()
        }
        if (vendorInfo.sftp.sftpHost == '' || vendorInfo.sftp.sftpPassword == '' || vendorInfo.sftp.sftpUsername == '') {
            req.flash('errors', {
                msg: 'You should have SFTP information to manage product feed. Please contact with Administrator.'
            })
            errorExist = true
            res.redirect('/')
            return next()
        }
        if (vendorInfo.active == 'yes') {
            shopify = new Shopify({
                shopName: vendorInfo.api.apiShop,
                apiKey: vendorInfo.api.apiKey,
                password: vendorInfo.api.apiPassword,
                timeout: 50000,
                autoLimit: {
                    calls: 2,
                    interval: 1000,
                    bucketSize: 35
                }
            })
        }
        // Check vendor availability. If vendor's status is inactive, it should redirect to homepage without any action.
        if (vendorInfo.active == 'no') {
            req.flash('errors', {
                msg: 'Your vendor should be active to manage feed. Please contact with Administrator.'
            })
            errorExist = true
            res.redirect('/')
            return next()
        }

        // Check product connector
        Connector.find({
            vendorId: vendorInfo._id,
            kwiLocation: 'product',
            active: 'yes'
        }, (err, connectors) => {
            if (err) {
                return next(err)
            }
            if (connectors.length == 0) {
                req.flash('errors', {
                    msg: 'Your vendor does not include product connector or it is inactive. Please contact with Administrator or Admin User.'
                })
                errorExist = true
                res.redirect('/')
                return next()
            }
            connectorInfo = connectors[0]
        })
    })

    const sftp = new Client() // sftp client
    var taxCodeKeys = Object.keys(TaxCodeList)
    var taxonomyKeys = Object.keys(TaxonomyList)

    var productDataList = new Array()
    var productViewList = new Array()
    var bestSellCollectionId
    var shopData
    var BreakException = {}

    // Initialize product feed file with empty
    commonHelper.deleteAndInitialize(productFileName)

    // Check user's active/inactive status.
    if (req.user.active !== 'yes') {
        req.flash('errors', {
            msg: 'Your account is inactive now. Please contact with Administrator.'
        })
        errorExist = true
        res.redirect('/')
        return next()
    }

    await delay(2000)
    if (!errorExist) {
        shopify.metafield.list().then(async metas => {
            metaList = metas.reduce((r, a) => {
                r[a.owner_id] = r[a.owner_id] || []
                r[a.owner_id].push(a)
                return r
            }, Object.create(null))
        }).catch((e) => {
            console.log(e)
        })

        shopify.shop.get().then((shop) => {
            shopData = shop
        }).catch(err => {
            console.log(err)
        })

        await delay(2000)

        shopify.product.list({
            limit: 250,
            published_status: 'published'
        }).then(products => {
            // Code to make a file with raw data. Should delete after finishing this feed.
            /*products.forEach(product => {
                var temp = product
                temp.body_html = 'product description'
                writeProductFile(JSON.stringify(temp), 0, (writeError, writeResponse) => {
                    isFirstVariant = false
                    if (writeError){
                        console.log('writeError: ', writeError)
                    }
                    if (writeResponse == 'success') {
                        console.log('Writing ...')
                    }
                })
            })
            tempProducts = []
            products.forEach(product => {
                var temp = product
                temp.body_html = 'product description'
                tempProducts.push(temp)
            })
            fs.writeFile("uploads/backup/product-raw-hedge.tsv", TSV.stringify(tempProducts))*/
            products.forEach(product => {
                const metafields = metaList[product.id]
                var productCategory = ''
                var isFirstVariant = true
                var firstVariantColor = ''
                // var firstVariantSku = ''
                // var firstVariantId = ''
                product.variants.forEach((variant) => {
                    var productData = {}
                    var productView = {}
                    // productData.Brand = product.vendor
                    productData.Brand = vendorInfo.brandName
                    productData.Category = productCategory

                    productData.ProductCode = ''
                    productData.ParentCode = ''
                    productData.ProductName = '"' + product.title.replace(/\r?\n|\r/g, '').replace(/\"/g, '""') + '"'
                    productView.title = '"' + product.title.replace(/\r?\n|\r/g, '').replace(/\"/g, '""') + '"'
                    productData.ProductDescription = ''
                    if (product.body_html) {
                        productData.ProductDescription = product.body_html.replace(/(<([^>]+)>)/ig, "")
                        productData.ProductDescription = '"' + productData.ProductDescription.replace(/\r?\n|\r/g, '').replace(/\"/g, '""') + '"'
                    }
                    productView.description = productData.ProductDescription

                    if (product.published_at) {
                        var publishYear = product.published_at.substr(0, 4)
                        var publishMonth = parseInt(product.published_at.substr(5, 2))
                        var publishSeason = ''
                        if (publishMonth < 6 && publishMonth > 2) {
                            publishSeason = 'Spring'
                        } else if (publishMonth > 5 && publishMonth < 9) {
                            publishSeason = 'Summer'
                        } else if (publishMonth > 8 && publishMonth < 12) {
                            publishSeason = 'Fall'
                        } else {
                            publishSeason = 'Winter'
                        }
                    }
                    // var today = new Date()
                    // var daysDifference = daysBetween(product.published_at)
                    var ColorName = ''
                    var Size = ''
                    var ProductCodeOption = ''
                    if (product.options.length > 0) {
                        var keyIndex = 1
                        product.options.forEach(option => {
                            if (option.name.toLowerCase() == 'size') {
                                Size = variant['option' + keyIndex]
                            }
                            if (option.name.toLowerCase() == 'color') {
                                var color = variant['option' + keyIndex]
                                ColorName = commonHelper.jsUcfirst(color)
                                if (isFirstVariant) {
                                    firstVariantColor = color
                                    firstVariantSku = variant.sku
                                    firstVariantId = variant.id
                                    isFirstVariant = false
                                }
                            }
                            if (option.name.toLowerCase() == 'productcode' || option.name.toLowerCase() == 'product code') {
                                ProductCodeOption = 'option' + keyIndex
                            }

                            keyIndex++
                        })
                    }
                    if (firstVariantColor == '' && isFirstVariant) {
                        firstVariantId = variant.id
                        isFirstVariant = false
                    }
                    var shortColorName = commonHelper.getShortenColorName(ColorName)
                    var shortFirstColorName = commonHelper.getShortenColorName(firstVariantColor)
                    if (ProductCodeOption == '') {
                        productData.ProductCode = shortColorName==''?variant.product_id.toString() : variant.product_id.toString() + '_' + shortColorName
                        productData.ParentCode = shortFirstColorName==''?variant.product_id.toString() : variant.product_id.toString() + '_' + shortFirstColorName
                    } else {
                        productData.ProductCode = shortColorName==''?variant[ProductCodeOption] : variant[ProductCodeOption] + '_' + shortColorName
                        productData.ParentCode = shortFirstColorName==''?variant[ProductCodeOption] : variant[ProductCodeOption] + '_' + shortFirstColorName
                    }
                    var ProductDescription2 = ''
                    var ProductOverview = ''
                    var ProductType = 'Apparel'
                    try {
                        ProductTypeList.forEach(ProductTypeItem => {
                            if (ProductTypeItem.toLowerCase() == product.product_type.toLowerCase()) {
                                ProductType = ProductTypeItem
                                throw BreakException
                            }
                        })
                    } catch (e) {
                        if (e !== BreakException) throw e
                    }
                    // Regenerate the `Category` field by `ProductType`
                    try {
                        taxonomyKeys.forEach(taxoKey => {
                            var lowercaseTaxonomy = TaxonomyList[taxoKey].toLowerCase()
                            var splittedTaxonomyByGreater = lowercaseTaxonomy.split(' > ')
                            var taxoItem = splittedTaxonomyByGreater[splittedTaxonomyByGreater.length - 1]
                            if (taxoItem.indexOf(ProductType.toLowerCase()) != -1) {
                                productData.Category = TaxonomyList[taxoKey]
                                throw BreakException
                            }
                        })
                    } catch (e) {
                        if (e !== BreakException) throw e
                    }
                    var ProductVideo = ''
                    var MaterialContent = ''
                    var VendorModelNumber = ''
                    var MSRP = variant.price
                    var MinQty = 1
                    var MaxQty = variant.inventory_quantity > 0 ? variant.inventory_quantity:1
                    var UPC = variant.id
                    var MoreInfo = ''
                    var WarehouseCode = "001".toString()
                    if (metafields) {
                        metafields.forEach(meta => {
                            if (meta.key == 'productDescription2') {
                                ProductDescription2 = meta.value
                            }
                            if (meta.key == 'overview') {
                                ProductOverview = meta.value
                            }
                            if (meta.key == 'productVideo') {
                                ProductVideo = meta.value
                            }
                            if (meta.key == 'materialContent') {
                                MaterialContent = meta.value
                            }
                            if (meta.key == 'vendorModelNumber') {
                                VendorModelNumber = meta.value
                            }
                            if (meta.key == 'msrp') {
                                MSRP = meta.value
                            }
                            if (meta.key == 'minQty') {
                                MinQty = meta.value
                            }
                            if (meta.key == 'maxQty') {
                                MaxQty = meta.value
                            }
                            if (meta.key == 'upc' && meta.value != '') {
                                UPC = meta.value
                            }
                            if (meta.key == 'moreInfo') {
                                MoreInfo = meta.value
                            }
                            if (meta.key == 'warehouseCode') {
                                WarehouseCode = meta.value
                            }
                        })
                    }
                    if (metafields && metafields.length > 0) {
                        productData.ProductDescription2 = ProductDescription2
                        productData.ProductOverview = ProductOverview
                        productData.ProductType = ProductType
                        productData.MaterialContent = MaterialContent
                        productData.CountryOfOrigin = shopData.country
                        productData.VendorModelNumber = VendorModelNumber
                        productData.Vendor = product.vendor
                        if (product.published_at) {
                            productData.Season = publishSeason + ' ' + publishYear
                        } else {
                            productData.Season = ''
                        }
                        productData.ColorName = ColorName.replace(' ', '')
                        productData.Size = Size
                        productData.DateAvailable = ''
                        if (product.published_at) {
                            productData.DateAvailable = product.published_at.substr(5, 2) + '/' + product.published_at.substr(8, 2) + '/' + publishYear
                        }
                        productData.Gender = 'Mens'
                        if (product.gender) {
                            productData.Gender = product.gender
                        }
                        productData.Weight = 0
                        if (product.weight) {
                            productData.Weight = product.weight
                        } else {
                            productData.Weight = variant.weight
                        }
                        if (variant.weight_unit == 'g') {
                            productData.Weight = parseFloat(productData.Weight / 453.59237).toFixed(2)
                        } else if (variant.weight_unit == 'kg') {
                            productData.Weight = parseFloat(productData.Weight / 0.45359237).toFixed(2)
                        }
                        if (productData.Weight == 0) {
                            productData.Weight = 1
                        }
                        productData.Cost = ''
                        productData.Price = variant.price
                        productData.MSRP = MSRP
                        productData.Title = '"' + product.title.replace(/\r?\n|\r/g, '').replace(/\"/g, '""') + '"'
                        productData.MinQty = MinQty
                        productData.MaxQty = MaxQty
                        // productData.IsBestSeller = collect.collection_id == bestSellCollectionId ? true : false
                        productData.IsBestSeller = false
                        // if (daysDifference > 30) {
                        //     productData.IsNew = false
                        // } else {
                        //     productData.IsNew = true
                        // }
                        productData.IsNew = false
                        productData.IsExclusive = false
                        productData.IsSale = false
                        productData.SizeGroup = ''
                        productData.ColorGroup = ''

                        productData.ZoomImage1 = ''
                        productData.ProductVideo = ProductVideo
                        productData.SKU = variant.id
                        // if (variant.sku != '') {
                        //     productData.SKU = variant.sku + commonHelper.getShortenColorName(ColorName) + Size
                        // } else {
                        //     productData.SKU = productData.ProductCode
                        // }
                        productData.SkuPrice = variant.price
                        if (variant.compare_at_price && variant.compare_at_price > 0) {
                            productData.IsSale = true
                            productData.SkuPrice = variant.compare_at_price?variant.compare_at_price:variant.price
                        }
                        productData.UPC = UPC
                        productData.QtyOnHand = variant.inventory_quantity > 0 ? variant.inventory_quantity : 0
                        productData.MoreInfo = MoreInfo
                        productData.TaxCode = 'PC040100'
                        try {
                            taxCodeKeys.forEach((key) => {
                                TaxCodeList[key].forEach((taxType) => {
                                    if (product.product_type != '' && taxType.indexOf(product.product_type) !== -1) {
                                        productData.TaxCode = key
                                        throw BreakException
                                    }
                                })
                            })
                        } catch (e) {
                            if (e !== BreakException) throw e
                        }
                        if (!productData.TaxCode) {
                            productData.TaxCode = ''
                        }
                        productData.FinalSale = false
                        productData.CurrencyCode = shopData.currency
                        productData.WarehouseCode = WarehouseCode

                    } else {
                        productData.ProductDescription2 = ''
                        productData.ProductOverview = ''
                        productData.ProductType = ProductType
                        productData.MaterialContent = ''
                        productData.CountryOfOrigin = shopData.country
                        productData.VendorModelNumber = variant.sku
                        productData.Vendor = product.vendor
                        if (product.published_at) {
                            productData.Season = publishSeason + ' ' + publishYear
                        } else {
                            productData.Season = ''
                        }
                        productData.ColorName = ColorName.replace(' ', '')
                        productData.Size = Size
                        productData.DateAvailable = ''
                        if (product.published_at) {
                            productData.DateAvailable = product.published_at.substr(5, 2) + '/' + product.published_at.substr(8, 2) + '/' + publishYear
                        }
                        if (product.gender) {
                            productData.Gender = product.gender
                        } else {
                            productData.Gender = 'Mens'
                        }
                        if (product.weight) {
                            productData.Weight = product.weight
                        } else {
                            productData.Weight = variant.weight
                        }
                        if (variant.weight_unit == 'g') {
                            productData.Weight = parseFloat(productData.Weight / 453.59237).toFixed(2)
                        } else if (variant.weight_unit == 'kg') {
                            productData.Weight = parseFloat(productData.Weight / 0.45359237).toFixed(2)
                        }
                        if (productData.Weight == 0) {
                            productData.Weight = 1
                        }
                        productData.Cost = ''
                        productData.Price = variant.price
                        productData.MSRP = variant.price
                        productData.Title = '"' + product.title.replace(/\r?\n|\r/g, '').replace(/\"/g, '""') + '"'
                        productData.MinQty = MinQty
                        productData.MaxQty = MaxQty
                        // productData.IsBestSeller = collect.collection_id == bestSellCollectionId ? true : false
                        productData.IsBestSeller = false
                        // if (daysDifference > 30) {
                        //     productData.IsNew = false
                        // } else {
                        //     productData.IsNew = true
                        // }
                        productData.IsNew = false
                        productData.IsExclusive = false
                        productData.IsSale = false
                        productData.SizeGroup = ''
                        productData.ColorGroup = ''

                        productData.ZoomImage1 = ''
                        productData.ProductVideo = ''
                        if (variant.sku != '') {
                            // productData.SKU = variant.sku + commonHelper.getShortenColorName(ColorName) + Size
                            productData.SKU = variant.id
                        } else {
                            // productData.SKU = productData.ProductCode
                            productData.SKU = variant.id
                        }
                        productData.SkuPrice = variant.price
                        if (variant.compare_at_price && variant.compare_at_price > 0) {
                            productData.IsSale = true
                            productData.SkuPrice = variant.compare_at_price?variant.compare_at_price:variant.price
                        }
                        productData.UPC = UPC
                        productData.QtyOnHand = variant.inventory_quantity > 0 ? variant.inventory_quantity : 0
                        productData.MoreInfo = MoreInfo
                        productData.TaxCode = 'PC040100'
                        try {
                            taxCodeKeys.forEach((key) => {
                                TaxCodeList[key].forEach((taxType) => {
                                    if (product.product_type != '' && taxType.indexOf(product.product_type) !== -1) {
                                        productData.TaxCode = key
                                        throw BreakException
                                    }
                                })
                            })
                        } catch (e) {
                            if (e !== BreakException) throw e
                        }
                        if (!productData.TaxCode) {
                            productData.TaxCode = ''
                        }
                        productData.FinalSale = false
                        productData.CurrencyCode = shopData.currency
                        productData.WarehouseCode = "001".toString()
                    }

                    // productData.ColorSwatchImage = ""
                    if (variant.image_id) {
                        var variant_image = commonHelper.getVariantImage(product.images, variant.image_id)
                        var splittedByDot = variant_image.split('.')
                        var lastBlock = '.' + splittedByDot[splittedByDot.length - 1]
                        var splittedByExtend = variant_image.split(lastBlock)
                        productView.img1 = splittedByExtend[0] + '_1024x' + lastBlock
                    } else {
                        if (product.image) {
                            var splittedByDot = product.image.src.split('.')
                            var extendOfFile = '.' + splittedByDot[splittedByDot.length - 1]
                            var splittedByExtend = product.image.src.split(extendOfFile)
                            productView.img1 = splittedByExtend[0] + '_1024x' + extendOfFile
                        }
                    }
                    productData.ZoomImage1 = productView.img1
                    productData.FreeShip = true
                    productData.Action = 'Activate'

                    productView.handle = product.handle
                    productView.variantId = variant.id.toString()
                    productDataList.push(productData)
                    productViewList.push(productView)
                })
            })
        })
        .then(() => {
            sftp.connect({
                host: vendorInfo.sftp.sftpHost,
                port: process.env.SFTP_PORT,
                username: vendorInfo.sftp.sftpUsername,
                password: vendorInfo.sftp.sftpPassword
            })
            .then(async () => {
                await delay(2000)
                var vendorUrl = 'https://' + vendorInfo.api.apiShop + '.myshopify.com'
                fs.writeFile(productFileName, TSV.stringify(productDataList), (err) => {
                    if (err) {
                        console.log(err)
                    } else {
                        sftp.put(productFileName, '/incoming/products/products01.txt')
                        .then(response => {
                            commonHelper.addStatus(vendorInfo, connectorInfo, 2, (statusErr) => {
                                if (statusErr) {
                                    return next(statusErr)
                                } else {
                                    res.render('feeds/product', {
                                        title: 'Product',
                                        products: productViewList,
                                        vendorUrl: vendorUrl
                                    })
                                }
                            })
                            
                            sftp.end()
                        })
                        .catch(error => {
                            commonHelper.addStatus(vendorInfo, connectorInfo, 0, (statusErr) => {
                                if (statusErr) {
                                    return next(statusErr)
                                } else {
                                    req.flash('errors', {
                                        msg: 'There are problems when trying upload file. Please check your internet connection.'
                                    })
                                    res.redirect('/')
                                }
                            })
                        })
                    }
                })

            })
            .catch(error => {
                commonHelper.addStatus(vendorInfo, connectorInfo, 0, (statusErr) => {
                    if (statusErr) {
                        return next(statusErr)
                    } else {
                        req.flash('errors', {
                            msg: 'There are problems when trying to connect into sftp. Please make sure that sftp infomation of this vendor is correct.'
                        })
                        res.redirect('/')
                    }
                })
            })
        })
        .catch(err => {
            commonHelper.addStatus(vendorInfo, connectorInfo, 0, (statusErr) => {
                if (statusErr) {
                    return next(statusErr)
                } else {
                    req.flash('errors', {
                        msg: 'There are problems when trying to get product list from store. Please check your internet connection.'
                    })
                    res.redirect('/')
                }
            })
        })
    }
}

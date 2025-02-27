import { createAsyncThunk, createSelector, createSlice, PayloadAction } from '@reduxjs/toolkit'
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/dist/query/react'
import { CAIP19, caip19 } from '@shapeshiftoss/caip'
import { Asset, NetworkTypes } from '@shapeshiftoss/types'
import cloneDeep from 'lodash/cloneDeep'
import sortBy from 'lodash/sortBy'
import { getAssetService } from 'lib/assetService'
import { ReduxState } from 'state/reducer'
import { selectMarketData } from 'state/slices/marketDataSlice/marketDataSlice'
export type AssetsState = {
  byId: {
    [key: CAIP19]: Asset
  }
  ids: CAIP19[]
}

export const fetchAsset = createAsyncThunk('asset/fetchAsset', async (assetCAIP19: CAIP19) => {
  const service = await getAssetService()
  const asset = service?.byTokenId({ ...caip19.fromCAIP19(assetCAIP19) })
  const description = await service?.description({ asset })
  const result = { ...asset, description }
  return result
})

const initialState: AssetsState = {
  byId: {},
  ids: []
}

export const assets = createSlice({
  name: 'asset',
  initialState,
  reducers: {
    setAssets: (state, action: PayloadAction<AssetsState>) => {
      state.byId = { ...state.byId, ...action.payload.byId } // upsert
      state.ids = Array.from(new Set([...state.ids, ...action.payload.ids]))
    }
  },
  extraReducers: builder => {
    builder
      .addCase(fetchAsset.fulfilled, (state, { payload, meta }) => {
        const assetCAIP19 = meta.arg
        state.byId[assetCAIP19] = payload
        if (!state.ids.includes(assetCAIP19)) state.ids.push(assetCAIP19)
      })
      .addCase(fetchAsset.rejected, (state, { payload, meta }) => {
        console.error('fetchAsset rejected')
      })
  }
})

export const assetApi = createApi({
  reducerPath: 'assetApi',
  // not actually used, only used to satisfy createApi, we use a custom queryFn
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  // refetch if network connection is dropped, useful for mobile
  refetchOnReconnect: true,
  endpoints: build => ({
    getAssets: build.query<AssetsState, void>({
      // all assets
      queryFn: async () => {
        const service = await getAssetService()
        const assetArray = service?.byNetwork(NetworkTypes.MAINNET)
        const data = assetArray.reduce<AssetsState>((acc, cur) => {
          const { caip19 } = cur
          acc.byId[caip19] = cur
          acc.ids.push(caip19)
          return acc
        }, cloneDeep(initialState))
        return { data }
      },
      onCacheEntryAdded: async (_args, { dispatch, cacheDataLoaded, getCacheEntry }) => {
        await cacheDataLoaded
        const data = getCacheEntry().data
        data && dispatch(assets.actions.setAssets(data))
      }
    }),
    // TODO(0xdef1cafe): make this take a single asset and dispatch multiple actions
    getAssetDescriptions: build.query<AssetsState, CAIP19[]>({
      queryFn: async (assetIds, { getState }) => {
        const service = await getAssetService()
        // limitation of redux tookit https://redux-toolkit.js.org/rtk-query/api/createApi#queryfn
        const { byId: byIdOriginal, ids } = (getState() as any).assets as AssetsState
        const byId = cloneDeep(byIdOriginal)
        const reqs = assetIds.map(async id => service.description({ asset: byId[id] }))
        const responses = await Promise.allSettled(reqs)
        responses.forEach((res, idx) => {
          if (res.status === 'rejected') {
            console.warn(`getAssetDescription: failed to fetch description for ${assetIds[idx]}`)
            return
          }
          byId[assetIds[idx]].description = res.value
        })

        const data = { byId, ids }
        return { data }
      },
      onCacheEntryAdded: async (_args, { dispatch, cacheDataLoaded, getCacheEntry }) => {
        await cacheDataLoaded
        const data = getCacheEntry().data
        data && dispatch(assets.actions.setAssets(data))
      }
    })
  })
})

export const { useGetAssetsQuery } = assetApi

export const selectAssetByCAIP19 = createSelector(
  (state: ReduxState) => state.assets.byId,
  (_state: ReduxState, CAIP19: CAIP19) => CAIP19,
  (byId, CAIP19) => byId[CAIP19]
)

// TODO(0xdef1cafe): add caip19s to buy and sell assets in swapper and remove this
export const selectAssetBySymbol = createSelector(
  (state: ReduxState) => state.assets.byId,
  (_state: ReduxState, symbol: string) => symbol,
  (byId, symbol) => Object.values(byId).find(asset => asset.symbol === symbol)
)

export const selectAssets = (state: ReduxState) => state.assets.byId
export const selectAssetIds = (state: ReduxState) => state.assets.ids

export const selectAssetsByMarketCap = createSelector(
  selectAssets,
  selectMarketData,
  (assetsByIdOriginal, marketData) => {
    const assetById = cloneDeep(assetsByIdOriginal)
    if (marketData) {
      // we only fetch market data for the top 1000 assets
      // and want this to be fairly performant so do some mutatey things
      const caip19ByMarketCap = Object.keys(marketData)
      const sortedWithMarketCap = caip19ByMarketCap.reduce<Asset[]>((acc, cur) => {
        const asset = assetById[cur]
        if (!asset) return acc
        acc.push(asset)
        delete assetById[cur]
        return acc
      }, [])
      const remainingSortedNoMarketCap = sortBy(Object.values(assetById), ['name', 'symbol'])
      return [...sortedWithMarketCap, ...remainingSortedNoMarketCap]
    } else {
      return sortBy(assetById, ['name', 'symbol'])
    }
  }
)

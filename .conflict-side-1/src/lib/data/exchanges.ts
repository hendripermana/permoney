// AUTO-GENERATED from src/lib/exchanges.yml — DO NOT EDIT BY HAND.
// Regenerate via `node scripts/convert-yaml-to-ts.mjs`.
//
// Source: ISO 10383 Market Identifier Codes (MIC).
// Used by the (future) Asset/Holding model to identify where a security trades.

export interface ExchangeDefinition {
  readonly name: string
  readonly country: string
}

/** Literal union of all known MIC codes. */
export type MicCode =
  | "AMXO"
  | "ARCO"
  | "ARCX"
  | "BATS"
  | "BVMF"
  | "EDGX"
  | "IEXG"
  | "MEMX"
  | "NEOE"
  | "OTCB"
  | "OTCM"
  | "OTCQ"
  | "PINX"
  | "PSGM"
  | "XADS"
  | "XAMS"
  | "XASE"
  | "XASX"
  | "XATH"
  | "XBER"
  | "XBKK"
  | "XBOG"
  | "XBOM"
  | "XBOS"
  | "XBRU"
  | "XBUE"
  | "XCBO"
  | "XCBT"
  | "XCHI"
  | "XCIS"
  | "XCME"
  | "XCNQ"
  | "XCSE"
  | "XDFM"
  | "XDUB"
  | "XDUS"
  | "XETR"
  | "XFKA"
  | "XFRA"
  | "XHAM"
  | "XHAN"
  | "XHEL"
  | "XHKG"
  | "XICE"
  | "XIDX"
  | "XIST"
  | "XJPX"
  | "XJSE"
  | "XKLS"
  | "XKOS"
  | "XKRX"
  | "XLIM"
  | "XLIS"
  | "XLME"
  | "XLON"
  | "XMAD"
  | "XMEX"
  | "XMIL"
  | "XMUN"
  | "XNAS"
  | "XNCM"
  | "XNDQ"
  | "XNGO"
  | "XNGS"
  | "XNMS"
  | "XNSE"
  | "XNYM"
  | "XNYS"
  | "XNZE"
  | "XOSE"
  | "XOSL"
  | "XPAR"
  | "XPHS"
  | "XPRA"
  | "XPSX"
  | "XSAP"
  | "XSAU"
  | "XSES"
  | "XSGO"
  | "XSHE"
  | "XSHG"
  | "XSTO"
  | "XSTU"
  | "XSWX"
  | "XTAE"
  | "XTAI"
  | "XTKS"
  | "XTSE"
  | "XTSX"
  | "XVTX"
  | "XWAR"
  | "XWBO"

export const EXCHANGES: Readonly<Record<MicCode, ExchangeDefinition>> = {
  AMXO: {
    name: "NYSE American Options",
    country: "US",
  },
  ARCO: {
    name: "NYSE Arca Options",
    country: "US",
  },
  ARCX: {
    name: "NYSE Arca",
    country: "US",
  },
  BATS: {
    name: "CBOE BZX",
    country: "US",
  },
  BVMF: {
    name: "B3 Brazil",
    country: "BR",
  },
  EDGX: {
    name: "CBOE EDGX",
    country: "US",
  },
  IEXG: {
    name: "IEX",
    country: "US",
  },
  MEMX: {
    name: "MEMX",
    country: "US",
  },
  NEOE: {
    name: "NEO",
    country: "CA",
  },
  OTCB: {
    name: "OTCQB",
    country: "US",
  },
  OTCM: {
    name: "OTC Markets",
    country: "US",
  },
  OTCQ: {
    name: "OTCQX",
    country: "US",
  },
  PINX: {
    name: "OTC Pink",
    country: "US",
  },
  PSGM: {
    name: "OTC Grey",
    country: "US",
  },
  XADS: {
    name: "Abu Dhabi",
    country: "AE",
  },
  XAMS: {
    name: "Euronext Amsterdam",
    country: "NL",
  },
  XASE: {
    name: "NYSE American",
    country: "US",
  },
  XASX: {
    name: "ASX",
    country: "AU",
  },
  XATH: {
    name: "Athens",
    country: "GR",
  },
  XBER: {
    name: "Berlin",
    country: "DE",
  },
  XBKK: {
    name: "Thailand",
    country: "TH",
  },
  XBOG: {
    name: "Colombia",
    country: "CO",
  },
  XBOM: {
    name: "BSE India",
    country: "IN",
  },
  XBOS: {
    name: "NASDAQ BX",
    country: "US",
  },
  XBRU: {
    name: "Euronext Brussels",
    country: "BE",
  },
  XBUE: {
    name: "Buenos Aires",
    country: "AR",
  },
  XCBO: {
    name: "CBOE",
    country: "US",
  },
  XCBT: {
    name: "CBOT",
    country: "US",
  },
  XCHI: {
    name: "NYSE Chicago",
    country: "US",
  },
  XCIS: {
    name: "NYSE National",
    country: "US",
  },
  XCME: {
    name: "CME",
    country: "US",
  },
  XCNQ: {
    name: "CSE",
    country: "CA",
  },
  XCSE: {
    name: "Copenhagen",
    country: "DK",
  },
  XDFM: {
    name: "Dubai",
    country: "AE",
  },
  XDUB: {
    name: "Euronext Dublin",
    country: "IE",
  },
  XDUS: {
    name: "Düsseldorf",
    country: "DE",
  },
  XETR: {
    name: "Xetra",
    country: "DE",
  },
  XFKA: {
    name: "Fukuoka",
    country: "JP",
  },
  XFRA: {
    name: "Frankfurt",
    country: "DE",
  },
  XHAM: {
    name: "Hamburg",
    country: "DE",
  },
  XHAN: {
    name: "Hannover",
    country: "DE",
  },
  XHEL: {
    name: "Helsinki",
    country: "FI",
  },
  XHKG: {
    name: "Hong Kong",
    country: "HK",
  },
  XICE: {
    name: "Iceland",
    country: "IS",
  },
  XIDX: {
    name: "Indonesia",
    country: "ID",
  },
  XIST: {
    name: "Istanbul",
    country: "TR",
  },
  XJPX: {
    name: "Japan Exchange",
    country: "JP",
  },
  XJSE: {
    name: "Johannesburg",
    country: "ZA",
  },
  XKLS: {
    name: "Malaysia",
    country: "MY",
  },
  XKOS: {
    name: "KOSDAQ",
    country: "KR",
  },
  XKRX: {
    name: "Korea Exchange",
    country: "KR",
  },
  XLIM: {
    name: "Lima",
    country: "PE",
  },
  XLIS: {
    name: "Euronext Lisbon",
    country: "PT",
  },
  XLME: {
    name: "London Metal Exchange",
    country: "GB",
  },
  XLON: {
    name: "London Stock Exchange",
    country: "GB",
  },
  XMAD: {
    name: "BME Madrid",
    country: "ES",
  },
  XMEX: {
    name: "Mexico",
    country: "MX",
  },
  XMIL: {
    name: "Euronext Milan",
    country: "IT",
  },
  XMUN: {
    name: "Munich",
    country: "DE",
  },
  XNAS: {
    name: "NASDAQ",
    country: "US",
  },
  XNCM: {
    name: "NASDAQ",
    country: "US",
  },
  XNDQ: {
    name: "NASDAQ Options",
    country: "US",
  },
  XNGO: {
    name: "Nagoya",
    country: "JP",
  },
  XNGS: {
    name: "NASDAQ",
    country: "US",
  },
  XNMS: {
    name: "NASDAQ",
    country: "US",
  },
  XNSE: {
    name: "NSE India",
    country: "IN",
  },
  XNYM: {
    name: "NYMEX",
    country: "US",
  },
  XNYS: {
    name: "NYSE",
    country: "US",
  },
  XNZE: {
    name: "NZX",
    country: "NZ",
  },
  XOSE: {
    name: "Osaka",
    country: "JP",
  },
  XOSL: {
    name: "Euronext Oslo",
    country: "NO",
  },
  XPAR: {
    name: "Euronext Paris",
    country: "FR",
  },
  XPHS: {
    name: "Philippines",
    country: "PH",
  },
  XPRA: {
    name: "Prague",
    country: "CZ",
  },
  XPSX: {
    name: "NASDAQ PSX",
    country: "US",
  },
  XSAP: {
    name: "Sapporo",
    country: "JP",
  },
  XSAU: {
    name: "Saudi (Tadawul)",
    country: "SA",
  },
  XSES: {
    name: "Singapore",
    country: "SG",
  },
  XSGO: {
    name: "Santiago",
    country: "CL",
  },
  XSHE: {
    name: "Shenzhen",
    country: "CN",
  },
  XSHG: {
    name: "Shanghai",
    country: "CN",
  },
  XSTO: {
    name: "Stockholm",
    country: "SE",
  },
  XSTU: {
    name: "Stuttgart",
    country: "DE",
  },
  XSWX: {
    name: "SIX Swiss",
    country: "CH",
  },
  XTAE: {
    name: "Tel Aviv",
    country: "IL",
  },
  XTAI: {
    name: "Taiwan",
    country: "TW",
  },
  XTKS: {
    name: "Tokyo",
    country: "JP",
  },
  XTSE: {
    name: "Toronto",
    country: "CA",
  },
  XTSX: {
    name: "TSX Venture",
    country: "CA",
  },
  XVTX: {
    name: "SIX Swiss",
    country: "CH",
  },
  XWAR: {
    name: "Warsaw",
    country: "PL",
  },
  XWBO: {
    name: "Vienna",
    country: "AT",
  },
} as const

/** Runtime predicate. */
export function isMicCode(value: unknown): value is MicCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(EXCHANGES, value)
  )
}

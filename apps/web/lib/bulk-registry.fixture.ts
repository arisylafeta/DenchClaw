import type { Registry } from "./bulk-registry";

/** Test-only copy of the registry as seeded by migration 064. The application reads the database, never this file. */
export const TEST_REGISTRY: Registry = {
  "fields": {
    "cells": [
      {
        "key": "model",
        "label": "Cell model",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "format",
        "label": "Format",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "chemistry",
        "label": "Chemistry",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "capacity",
        "label": "Capacity per cell",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "quantity",
        "label": "Quantity",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "soh",
        "label": "State of health",
        "neededFor": "Bids",
        "visibility": "after_nda"
      },
      {
        "key": "test_data",
        "label": "Test data",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "manufacture_date",
        "label": "Manufacture date",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "seller_price",
        "label": "Seller price",
        "neededFor": "Closing",
        "visibility": "never"
      },
      {
        "key": "sale_route",
        "label": "Sale route",
        "neededFor": "Bids",
        "visibility": "teaser"
      },
      {
        "key": "clear_by",
        "label": "Clear warehouse by",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      },
      {
        "key": "location",
        "label": "Location",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "transport_class",
        "label": "Transport class",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      }
    ],
    "packs": [
      {
        "key": "model",
        "label": "Pack model",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "chemistry",
        "label": "Chemistry",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "capacity",
        "label": "Capacity per pack",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "quantity",
        "label": "Quantity",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "soh",
        "label": "State of health",
        "neededFor": "Bids",
        "visibility": "after_nda"
      },
      {
        "key": "test_data",
        "label": "BMS or test data",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "manufacture_date",
        "label": "Manufacture date",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "seller_price",
        "label": "Seller price",
        "neededFor": "Closing",
        "visibility": "never"
      },
      {
        "key": "sale_route",
        "label": "Sale route",
        "neededFor": "Bids",
        "visibility": "teaser"
      },
      {
        "key": "clear_by",
        "label": "Clear warehouse by",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      },
      {
        "key": "location",
        "label": "Location",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "transport_class",
        "label": "Transport class",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      }
    ],
    "recycling": [
      {
        "key": "model",
        "label": "Battery type",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "chemistry",
        "label": "Chemistry",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "quantity",
        "label": "Quantity",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "weight",
        "label": "Weight (tonnes)",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "condition",
        "label": "Condition",
        "neededFor": "Bids",
        "visibility": "after_nda"
      },
      {
        "key": "countries",
        "label": "Countries crossed",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      },
      {
        "key": "local_recycler",
        "label": "Local recycler",
        "neededFor": "Shipping",
        "visibility": "never"
      },
      {
        "key": "seller_price",
        "label": "Recycling fee",
        "neededFor": "Closing",
        "visibility": "never"
      },
      {
        "key": "clear_by",
        "label": "Collect by",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      },
      {
        "key": "location",
        "label": "Location",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "transport_class",
        "label": "Transport class",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      }
    ],
    "systems": [
      {
        "key": "model",
        "label": "System model",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "chemistry",
        "label": "Chemistry",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "energy",
        "label": "Energy",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "power",
        "label": "Power",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "quantity",
        "label": "Units",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "commissioned",
        "label": "Commissioned",
        "neededFor": "Teaser",
        "visibility": "teaser"
      },
      {
        "key": "soh",
        "label": "State of health",
        "neededFor": "Bids",
        "visibility": "after_nda"
      },
      {
        "key": "test_data",
        "label": "Operating data",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "seller_price",
        "label": "Seller price",
        "neededFor": "Closing",
        "visibility": "never"
      },
      {
        "key": "sale_route",
        "label": "Sale route",
        "neededFor": "Bids",
        "visibility": "teaser"
      },
      {
        "key": "clear_by",
        "label": "Clear warehouse by",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      },
      {
        "key": "location",
        "label": "Location",
        "neededFor": "Bids",
        "visibility": "after_loi"
      },
      {
        "key": "transport_class",
        "label": "Transport class",
        "neededFor": "Shipping",
        "visibility": "after_nda"
      }
    ]
  },
  "requiredFiles": [
    {
      "type": "Photos",
      "label": "Photos",
      "neededFor": "Teaser"
    },
    {
      "type": "Test report",
      "label": "BMS or test report",
      "neededFor": "Bids"
    },
    {
      "type": "Datasheet",
      "label": "Datasheet",
      "neededFor": "Bids"
    },
    {
      "type": "Transport documents",
      "label": "Transport documents",
      "neededFor": "Shipping"
    }
  ],
  "specLists": {
    "chemistries": [
      "LFP",
      "NMC",
      "NCA",
      "LMO",
      "LMFP",
      "LTO",
      "Sodium-ion",
      "Lead-acid",
      "Mixed"
    ],
    "formats": [
      "Cells",
      "Modules",
      "Packs",
      "Systems"
    ],
    "cell_formats": [
      "Cylindrical",
      "Prismatic",
      "Pouch"
    ],
    "conditions": [
      "New or surplus",
      "Second-life, tested",
      "Second-life, untested",
      "Recall stock",
      "B-grade or production scrap",
      "Damaged or end of life"
    ],
    "origins": [
      "Passenger EV",
      "Bus or truck",
      "Stationary storage",
      "Industrial",
      "Consumer or other"
    ],
    "makes": [
      "Tesla",
      "VW Group",
      "Renault",
      "Nissan",
      "Hyundai or Kia",
      "BMW or Mini",
      "Mercedes-Benz",
      "Stellantis",
      "Ford",
      "GM",
      "BYD",
      "MG or SAIC",
      "Volvo or Polestar",
      "JLR",
      "Toyota or Lexus"
    ],
    "cell_makers": [
      "CATL",
      "LG",
      "Samsung SDI",
      "SK On",
      "Panasonic",
      "BYD",
      "EVE",
      "CALB",
      "Gotion",
      "Northvolt",
      "AESC"
    ],
    "system_brands": [
      "BYD",
      "Sungrow",
      "CATL",
      "Tesla",
      "Huawei",
      "Fluence",
      "LG",
      "Samsung SDI",
      "W\u00e4rtsil\u00e4",
      "Pylontech",
      "Other"
    ],
    "evidence": [
      "BMS readout",
      "Capacity test",
      "Internal resistance",
      "Usage history",
      "Photos",
      "UN 38.3 and shipping documents",
      "Any stated method",
      "None, they test"
    ],
    "excludes": [
      "Fire or thermal history",
      "Water or impact damage",
      "No test data",
      "Unknown provenance"
    ]
  },
  "specLabels": {
    "chemistries": "Chemistry",
    "formats": "Format",
    "cell_formats": "Cell format",
    "conditions": "Condition",
    "origins": "From",
    "makes": "Vehicle makes",
    "cell_makers": "Cell makers",
    "system_brands": "System brands",
    "evidence": "Evidence needed",
    "excludes": "Won't take"
  },
  "specNumbers": {
    "kwh_min": {
      "label": "Min kWh per unit",
      "min": 0,
      "max": 100000
    },
    "kwh_max": {
      "label": "Max kWh per unit",
      "min": 0,
      "max": 100000
    },
    "min_soh": {
      "label": "Min SOH %",
      "min": 0,
      "max": 100
    }
  },
  "volumeUnits": [
    "packs",
    "modules",
    "cells",
    "systems",
    "kWh",
    "MWh",
    "tonnes"
  ],
  "priceUnits": [
    "kWh",
    "pack",
    "cell"
  ],
  "currencies": [
    "EUR",
    "USD",
    "GBP"
  ]
};

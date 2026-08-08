// CarGurus make -> entity id ("m<number>") map.
// Extracted live from the CarGurus SRP filter data (119 makes, US site).
// content-cargurus.js also re-extracts this from the live page as a fallback,
// so this list just makes the first search fast and reliable.
self.CARGURUS_MAKES = {
  "Acura": "m4", "Alfa Romeo": "m124", "AM General": "m79", "AMC": "m133",
  "Armstrong-Siddeley": "m303", "Aston Martin": "m110", "Auburn": "m213",
  "Audi": "m19", "Austin": "m119", "Austin-Healey": "m139", "Bentley": "m20",
  "BMW": "m3", "Bricklin": "m196", "Bugatti": "m113", "Buick": "m21",
  "Cadillac": "m22", "Chevrolet": "m1", "Chrysler": "m23", "Citroen": "m117",
  "Daewoo": "m81", "Daihatsu": "m95", "Datsun": "m96", "De Tomaso": "m179",
  "DeLorean": "m97", "DeSoto": "m208", "Dodge": "m24", "Durant": "m297",
  "Eagle": "m82", "Edsel": "m174", "Essex": "m304", "Excalibur": "m198",
  "Ferrari": "m25", "FIAT": "m98", "Fisker": "m183", "Ford": "m2",
  "Freightliner": "m99", "Genesis": "m203", "Geo": "m83", "Ghia": "m284",
  "GMC": "m26", "Graham": "m247", "Honda": "m6", "Hudson": "m186",
  "Hummer": "m27", "Hyundai": "m28", "Ineos": "m283", "INFINITI": "m84",
  "Intermeccanica": "m241", "International Harvester": "m158", "Isuzu": "m30",
  "Jaguar": "m31", "Jeep": "m32", "Jensen": "m200", "Kaiser": "m189",
  "Karma": "m233", "Kia": "m33", "Lada": "m155", "Lamborghini": "m34",
  "Lancia": "m100", "Land Rover": "m35", "LaSalle": "m248", "Lexus": "m37",
  "Lincoln": "m38", "Lotus": "m39", "Lucid": "m274", "Maserati": "m40",
  "Maybach": "m41", "Mazda": "m42", "McLaren": "m141", "Mercedes-Benz": "m43",
  "Mercury": "m44", "MG": "m102", "MINI": "m45", "Mitsubishi": "m46",
  "Mobility Ventures": "m255", "Morgan": "m150", "Morris": "m151", "Nash": "m199",
  "Nissan": "m12", "Oldsmobile": "m85", "Overland": "m299", "Packard": "m176",
  "Pagani": "m121", "Paige": "m300", "Panoz": "m86", "Peerless": "m301",
  "Peugeot": "m104", "Pininfarina": "m105", "Plymouth": "m87", "Polestar": "m260",
  "Pontiac": "m47", "Porsche": "m48", "Qvale": "m254", "RAM": "m191",
  "Renault": "m106", "REO": "m209", "Rivian": "m243", "Rolls-Royce": "m49",
  "Rover": "m131", "Saab": "m50", "Saleen": "m108", "Saturn": "m51",
  "Scion": "m52", "Shelby": "m135", "smart": "m111", "SSC": "m187",
  "Studebaker": "m164", "Subaru": "m53", "Sunbeam": "m132", "Suzuki": "m54",
  "Tesla": "m112", "Toyota": "m7", "Triumph": "m137", "VinFast": "m279",
  "Volkswagen": "m55", "Volvo": "m56", "VPG": "m205", "White": "m302",
  "Willys": "m214"
};

// Common aliases so a make read off Inventory Plus still resolves.
self.CARGURUS_MAKE_ALIASES = {
  "mercedes": "Mercedes-Benz",
  "mercedes benz": "Mercedes-Benz",
  "mercedesbenz": "Mercedes-Benz",
  "mb": "Mercedes-Benz",
  "vw": "Volkswagen",
  "chevy": "Chevrolet",
  "infiniti": "INFINITI",
  "mini cooper": "MINI",
  "land-rover": "Land Rover",
  "landrover": "Land Rover",
  "alfa": "Alfa Romeo",
  "rolls royce": "Rolls-Royce",
  "aston": "Aston Martin"
};

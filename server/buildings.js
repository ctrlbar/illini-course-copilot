// Approximate coordinates of common UIUC instructional buildings, used to warn about
// tight back-to-back classes. Coordinates are approximate (good to ~50 m) — fine for
// walking-time estimates, not for navigation. Add buildings as you find them.
const B = {
  'Siebel Center for Comp Sci': [40.1138, -88.2249],
  'Siebel Center for Design': [40.1017, -88.2347],
  'Campus Instructional Facility': [40.1124, -88.2283],
  'Electrical & Computer Eng Bldg': [40.1150, -88.2280],
  'Grainger Engineering Library': [40.1125, -88.2269],
  'Digital Computer Laboratory': [40.1133, -88.2265],
  'Engineering Hall': [40.1110, -88.2270],
  'Everitt Laboratory': [40.1108, -88.2283],
  'Talbot Laboratory': [40.1119, -88.2268],
  'Transportation Building': [40.1117, -88.2286],
  'Mechanical Engineering Bldg': [40.1118, -88.2255],
  'Mechanical Engineering Lab': [40.1125, -88.2255],
  'Materials Science & Eng Bld': [40.1112, -88.2259],
  'Loomis Laboratory': [40.1107, -88.2238],
  'Newmark Civil Engineering Bldg': [40.1128, -88.2264],
  'Sidney Lu Mech Engr Bldg': [40.1118, -88.2255],
  'Kenney Gym Annex': [40.1129, -88.2281],
  'Altgeld Hall': [40.1093, -88.2283],
  'Illini Hall': [40.1097, -88.2294],
  'Henry Administration Bldg': [40.1084, -88.2287],
  'English Building': [40.1078, -88.2280],
  'Lincoln Hall': [40.1065, -88.2283],
  'Foellinger Auditorium': [40.1059, -88.2272],
  'Gregory Hall': [40.1068, -88.2296],
  'Noyes Laboratory': [40.1086, -88.2262],
  'Chemistry Annex': [40.1081, -88.2258],
  'Chemical & Life Sciences Lab': [40.1076, -88.2253],
  'Roger Adams Laboratory': [40.1076, -88.2247],
  'Natural History Building': [40.1093, -88.2259],
  'Davenport Hall': [40.1072, -88.2263],
  'Burrill Hall': [40.1071, -88.2240],
  'Morrill Hall': [40.1081, -88.2242],
  'Medical Sciences Building': [40.1088, -88.2238],
  'Psychology Building': [40.1074, -88.2306],
  'David Kinley Hall': [40.1045, -88.2290],
  'Wohlers Hall': [40.1036, -88.2299],
  'Business Instructional Fac': [40.1048, -88.2306],
  'Gies College of Business': [40.1048, -88.2306],
  'Education Building': [40.1041, -88.2317],
  'Main Library': [40.1046, -88.2290],
  'Undergraduate Library': [40.1046, -88.2272],
  'Smith Memorial Hall': [40.1061, -88.2247],
  'Music Building': [40.1060, -88.2232],
  'Krannert Center for Perf Arts': [40.1080, -88.2223],
  'Armory': [40.1043, -88.2361],
  'Huff Hall': [40.1040, -88.2366],
  'Freer Hall': [40.1046, -88.2228],
  'Turner Hall': [40.1037, -88.2265],
  'Animal Sciences Laboratory': [40.1039, -88.2246],
  'Bevier Hall': [40.1028, -88.2265],
  'Mumford Hall': [40.1028, -88.2254],
  'Plant Sciences Laboratory': [40.1031, -88.2235],
  'Agricultural Engr Sciences Bld': [40.1033, -88.2244],
  'Architecture Building': [40.1022, -88.2272],
  'Temple Hoyne Buell Hall': [40.1018, -88.2297],
  'Art and Design Building': [40.1016, -88.2286],
  'Krannert Art Museum': [40.1018, -88.2307],
  'Lincoln Hall Theater': [40.1065, -88.2283],
  'Coble Hall': [40.1079, -88.2296],
  'Illini Union': [40.1092, -88.2272],
  'Mathews Avenue Building': [40.1099, -88.2241],
  'Nuclear Physics Laboratory': [40.1145, -88.2290],
  'Beckman Institute': [40.1158, -88.2273],
  'Ceramics Building': [40.1120, -88.2244],
  'Speech & Hearing Science Bldg': [40.1018, -88.2328],
  'Gregory Hall Auditorium': [40.1068, -88.2296],
  'Labor & Employment Relations': [40.1034, -88.2311],
  'Library and Info Science Bldg': [40.1040, -88.2328],
  'Natural Resources Building': [40.1124, -88.2234],
  'State Farm Center': [40.0961, -88.2359],
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const lookup = new Map(Object.entries(B).map(([k, v]) => [norm(k), v]));

export function coords(building) {
  if (!building) return null;
  const n = norm(building);
  if (lookup.has(n)) return lookup.get(n);
  for (const [k, v] of lookup) if (k.startsWith(n.slice(0, 12)) || n.startsWith(k.slice(0, 12))) return v;
  return null;
}

/** Estimated walking minutes between two buildings, or null if either is unknown. */
export function walkMinutes(a, b) {
  if (!a || !b) return null;
  if (norm(a) === norm(b)) return 1;
  const p = coords(a), q = coords(b);
  if (!p || !q) return null;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (q[0] - p[0]) * rad, dLon = (q[1] - p[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[0] * rad) * Math.cos(q[0] * rad) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // sidewalks aren't straight lines
  return Math.max(2, Math.round(meters / 80)); // ~80 m/min walking pace
}

export const knownBuildings = () => Object.keys(B);

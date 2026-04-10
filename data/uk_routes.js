// (Unchanged, providing the static route data for the Haversine engine).
const routes = {
  M1_NORTHBOUND: [
    { lat: 51.5888, lng: -0.2289 },
    { lat: 51.6245, lng: -0.2764 },
    { lat: 51.7061, lng: -0.3672 },
    { lat: 51.7512, lng: -0.4045 },
    { lat: 51.8754, lng: -0.4631 },
  ],
  M4_WESTBOUND: [
    { lat: 51.4923, lng: -0.2792 },
    { lat: 51.4881, lng: -0.4414 },
    { lat: 51.505, lng: -0.6125 },
    { lat: 51.4844, lng: -0.7601 },
    { lat: 51.4285, lng: -0.9822 },
  ],
  M25_CLOCKWISE: [
    { lat: 51.4344, lng: -0.5501 },
    { lat: 51.3285, lng: -0.5282 },
    { lat: 51.2841, lng: -0.3315 },
    { lat: 51.2661, lng: -0.1652 },
    { lat: 51.2751, lng: -0.0101 },
  ],
};

module.exports = { routes };

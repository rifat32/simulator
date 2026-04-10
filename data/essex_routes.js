// data/essex_routes.js
// High-density coordinates for Chelmsford, Essex.
// Dense waypoints ensure the simulator follows the road curves and doesn't cut through gardens.

const routes = {
  route1_chelmsford: [
    { lat: 51.736021, lng: 0.468249 }, // Near Chelmsford Station
    { lat: 51.73645, lng: 0.4695 }, // Duke St
    { lat: 51.73678, lng: 0.4706 },
    { lat: 51.73711, lng: 0.4718 }, // Victoria Rd starts
    { lat: 51.7374, lng: 0.473 },
    { lat: 51.7376, lng: 0.4742 },
    { lat: 51.73775, lng: 0.4754 },
    { lat: 51.7378, lng: 0.4766 }, // Riverside Retail Park curve
    { lat: 51.7377, lng: 0.4778 },
    { lat: 51.7374, lng: 0.479 },
    { lat: 51.737, lng: 0.48 }, // Springfield Rd junction
    { lat: 51.7364, lng: 0.4808 },
    { lat: 51.7358, lng: 0.4815 },
    { lat: 51.7352, lng: 0.4822 },
    { lat: 51.7346, lng: 0.4829 }, // Tesco Extra roundabout
    { lat: 51.7341, lng: 0.4837 },
    { lat: 51.7337, lng: 0.4846 },
    { lat: 51.7334, lng: 0.4856 }, // Baddow Rd
    { lat: 51.7332, lng: 0.4866 },
    { lat: 51.7329, lng: 0.4878 },
    { lat: 51.7325, lng: 0.489 }, // Towards A1114
    { lat: 51.7321, lng: 0.49 },
    { lat: 51.7316, lng: 0.491 },
    { lat: 51.731, lng: 0.492 },
    { lat: 51.7303, lng: 0.4929 },
    { lat: 51.7295, lng: 0.4938 },
    { lat: 51.7286, lng: 0.4946 },
    { lat: 51.7276, lng: 0.4952 },
    { lat: 51.7266, lng: 0.4957 },
    { lat: 51.7256, lng: 0.496 }, // Army & Navy Roundabout approach
    { lat: 51.7246, lng: 0.4962 },
    { lat: 51.7236, lng: 0.4965 },
    { lat: 51.7226, lng: 0.4969 },
    { lat: 51.7216, lng: 0.4974 },
    { lat: 51.7206, lng: 0.498 }, // Essex Yeomanry Way
    { lat: 51.7196, lng: 0.4988 },
    { lat: 51.7187, lng: 0.4998 },
    { lat: 51.7179, lng: 0.501 },
    { lat: 51.7172, lng: 0.5024 },
    { lat: 51.7166, lng: 0.5038 },
    { lat: 51.7161, lng: 0.5052 },
    { lat: 51.7157, lng: 0.5066 }, // Approaching Howe Green
    { lat: 51.7153, lng: 0.508 },
    { lat: 51.715, lng: 0.5094 },
    { lat: 51.7147, lng: 0.5108 },
    { lat: 51.7144, lng: 0.5122 },
    { lat: 51.7142, lng: 0.5136 },
    { lat: 51.714, lng: 0.515 },
    { lat: 51.7138, lng: 0.5164 }, // Looping back logic handles the return
  ],
};

module.exports = { routes };

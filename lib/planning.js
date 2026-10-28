const fs = require("node:fs");
const path = require("node:path");

function readReference(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reference-data", name), "utf8"));
}

function dateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function hours(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }

function weekDates(start, end) {
  const dates = [];
  const current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function compareStaff(a, b, weeklyHours) {
  return (weeklyHours.get(a.staff_id) || 0) - (weeklyHours.get(b.staff_id) || 0) || a.name.localeCompare(b.name);
}

function calculatePlan({ orders, inventory, staff, leave, availability, imports }) {
  const scenario = readReference("scenario.json");
  const recipeData = readReference("products_and_recipes.json");
  const dates = weekDates(scenario.week_start, scenario.week_end);
  const dateSet = new Set(dates);
  const cutoffMs = Date.parse(scenario.order_cutoff);
  const products = new Map(recipeData.products.map((product) => [product.id, product]));
  const recipeByProduct = new Map();
  for (const recipe of recipeData.recipes) {
    if (!recipeByProduct.has(recipe.product_id)) recipeByProduct.set(recipe.product_id, []);
    recipeByProduct.get(recipe.product_id).push(recipe);
  }

  const eligibleOrders = [];
  const excludedOrders = [];
  for (const row of orders) {
    const productionDate = dateString(row.production_date);
    const receivedAt = new Date(row.received_at);
    const reasons = [];
    if (String(row.status).toLowerCase() !== "confirmed") reasons.push("not_confirmed");
    if (!dateSet.has(productionDate)) reasons.push("outside_planning_week");
    if (Number.isNaN(receivedAt.valueOf()) || receivedAt.valueOf() > cutoffMs) reasons.push("received_after_cutoff");
    const item = { ...row, production_date: productionDate, quantity: Number(row.quantity) };
    if (reasons.length) excludedOrders.push({ ...item, reasons });
    else eligibleOrders.push(item);
  }

  const dailyProduction = dates.map((date) => ({
    date,
    products: Object.fromEntries([...products.keys()].map((id) => [id, 0])),
    total_sandwiches: 0,
    labour_hours: 0,
    ingredient_demand: {}
  }));
  const dailyByDate = new Map(dailyProduction.map((day) => [day.date, day]));
  for (const order of eligibleOrders) {
    const day = dailyByDate.get(order.production_date);
    if (!day || !products.has(order.product_id)) continue;
    day.products[order.product_id] += order.quantity;
    day.total_sandwiches += order.quantity;
    day.labour_hours += order.quantity * Number(products.get(order.product_id).labour_hours_per_unit);
    for (const recipe of recipeByProduct.get(order.product_id) || []) {
      day.ingredient_demand[recipe.ingredient_id] = (day.ingredient_demand[recipe.ingredient_id] || 0) + order.quantity * Number(recipe.quantity_per_unit);
    }
  }

  const totalProduct = Object.fromEntries([...products.keys()].map((id) => [id, 0]));
  const totalIngredients = {};
  for (const day of dailyProduction) {
    day.labour_hours = hours(day.labour_hours);
    day.total_sandwiches = Number(day.total_sandwiches);
    for (const [id, quantity] of Object.entries(day.products)) totalProduct[id] += quantity;
    for (const [id, quantity] of Object.entries(day.ingredient_demand)) totalIngredients[id] = (totalIngredients[id] || 0) + quantity;
  }
  const totalLabourHours = hours(dailyProduction.reduce((sum, day) => sum + day.labour_hours, 0));
  const stockRequest = inventory.map((item) => {
    const onHand = Number(item.on_hand);
    const committed = Number(item.committed);
    const packSize = Number(item.pack_size);
    const usableStock = onHand - committed;
    const demand = Number(totalIngredients[item.ingredient_id] || 0);
    const shortage = Math.max(0, demand - usableStock);
    const packs = shortage > 0 ? Math.ceil(shortage / packSize) : 0;
    return {
      ingredient_id: item.ingredient_id,
      name: item.name,
      unit: item.unit,
      demand,
      on_hand: onHand,
      committed,
      usable_stock: usableStock,
      shortage,
      pack_size: packSize,
      pack_name: item.pack_name,
      packs_to_request: packs,
      request_quantity: packs * packSize
    };
  });

  const staffById = new Map(staff.map((person) => [person.staff_id, { ...person, skills: Array.isArray(person.skills) ? person.skills : [] }]));
  const approvedLeave = new Set(leave.filter((record) => String(record.status).toLowerCase() === "approved").map((record) => `${record.staff_id}|${dateString(record.leave_date)}`));
  const confirmedAvailability = availability.filter((record) => String(record.status).toLowerCase() === "confirmed");
  const weeklyHours = new Map(staff.map((person) => [person.staff_id, 0]));
  const roster = [];

  for (const date of dates) {
    const day = dailyByDate.get(date);
    const demand = day.labour_hours;
    const assigned = [];
    const used = new Set();
    let capacity = 0;
    const hasProduction = demand > 0;
    const eligiblePerson = (person) => person && person.skills.includes("production") && !approvedLeave.has(`${person.staff_id}|${date}`) && !used.has(person.staff_id);
    const addShift = (person, shift) => {
      used.add(person.staff_id);
      const productiveHours = Number(shift.productive_hours);
      capacity += productiveHours;
      weeklyHours.set(person.staff_id, hours((weeklyHours.get(person.staff_id) || 0) + productiveHours));
      assigned.push({ staff_id: person.staff_id, name: person.name, role: person.role, employment_type: person.employment_type, start: shift.start, end: shift.end, productive_hours: productiveHours, supervisor: person.skills.includes("supervisor") });
    };

    if (hasProduction) {
      const permanent = [...staffById.values()].filter((person) => person.employment_type.toLowerCase() === "permanent" && eligiblePerson(person));
      const leads = permanent.filter((person) => person.skills.includes("supervisor") && /lead/i.test(person.role)).sort((a, b) => compareStaff(a, b, weeklyHours));
      if (leads.length) addShift(leads[0], { start: scenario.settings.permanent_shift_start, end: scenario.settings.permanent_shift_end, productive_hours: scenario.settings.permanent_productive_hours });

      const remainingPermanent = permanent.filter((person) => !used.has(person.staff_id)).sort((a, b) => compareStaff(a, b, weeklyHours));
      for (const person of remainingPermanent) {
        if (capacity >= demand) break;
        addShift(person, { start: scenario.settings.permanent_shift_start, end: scenario.settings.permanent_shift_end, productive_hours: scenario.settings.permanent_productive_hours });
      }

      const dayAvailability = confirmedAvailability.filter((record) => dateString(record.shift_date) === date)
        .map((record) => ({ record, person: staffById.get(record.staff_id) }))
        .filter(({ person }) => person && person.employment_type.toLowerCase() !== "permanent" && eligiblePerson(person))
        .sort((a, b) => compareStaff(a.person, b.person, weeklyHours) || String(a.record.starts_at).localeCompare(String(b.record.starts_at)));
      for (const { record, person } of dayAvailability) {
        if (capacity >= demand) break;
        addShift(person, { start: String(record.starts_at).slice(0, 5), end: String(record.ends_at).slice(0, 5), productive_hours: scenario.settings.part_time_productive_hours });
      }
    }

    const uncoveredHours = hours(Math.max(0, demand - capacity));
    const leadAssigned = assigned.some((person) => person.supervisor && /lead/i.test(person.role));
    roster.push({
      date,
      labour_demand_hours: demand,
      assigned,
      scheduled_capacity_hours: hours(capacity),
      uncovered_hours: uncoveredHours,
      additional_four_hour_part_time_shifts_to_request: Math.ceil(uncoveredHours / Number(scenario.settings.part_time_productive_hours)),
      supervisor_lead_covered: hasProduction ? leadAssigned : true
    });
  }

  const totalScheduledCapacity = hours(roster.reduce((sum, day) => sum + day.scheduled_capacity_hours, 0));
  const totalUncoveredHours = hours(roster.reduce((sum, day) => sum + day.uncovered_hours, 0));
  const availableAdditionalShifts = roster.reduce((sum, day) => sum + day.additional_four_hour_part_time_shifts_to_request, 0);
  return {
    scenario: { name: scenario.scenario, timezone: scenario.timezone, cutoff: scenario.order_cutoff, week_start: scenario.week_start, week_end: scenario.week_end },
    imports,
    orders: { total: orders.length, eligible_count: eligibleOrders.length, excluded_count: excludedOrders.length, eligible: eligibleOrders, excluded: excludedOrders },
    production: { days: dailyProduction, totals_by_product: totalProduct, total_sandwiches: Object.values(totalProduct).reduce((sum, quantity) => sum + quantity, 0) },
    labour: { total_demand_hours: totalLabourHours, scheduled_capacity_hours: totalScheduledCapacity, uncovered_hours: totalUncoveredHours, additional_four_hour_shifts_to_request: availableAdditionalShifts },
    roster,
    ingredients: { demand: totalIngredients, stock_request: stockRequest }
  };
}

module.exports = { calculatePlan };

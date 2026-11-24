"""Build the one-time café retail catalogue migration from reviewed product data."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "retail-products.json"
DESTINATION = ROOT / "migrations" / "20261124_cafe_retail_catalog.sql"

GROUP_CATEGORIES = {
    "tricones": "retail-cones",
    "cups_55_60ml": "retail-cups",
    "cups_100ml": "retail-cups",
    "cups_125ml": "retail-cups",
    "sticks_kulfi": "retail-sticks",
    "sandwiches_novelties": "retail-novelties",
    "tubs_1l": "retail-tubs",
    "family_packs_750ml": "retail-family-packs",
    "combos_750ml": "retail-multipacks",
    "family_packs_2l": "retail-family-packs",
    "bulk_packs_4l": "retail-tubs",
    "bulk_packs_5l": "retail-tubs",
    "french_fries": "retail-frozen-snacks",
    "veg_patties": "retail-frozen-snacks",
    "milk_buttermilk": "retail-dairy-drinks",
    "lassi": "retail-dairy-drinks",
    "milkshakes_kool": "retail-dairy-drinks",
    "butter_ghee": "retail-dairy",
    "cheese_cream": "retail-dairy",
    "condensed_milk": "retail-dairy",
    "spreads": "retail-dairy",
    "milk_powders": "retail-dairy",
    "nutrition": "retail-dairy",
    "chocolate_bars": "retail-chocolates",
    "chocolate_wafers": "retail-chocolates",
    "cookies": "retail-snacks",
    "rusks": "retail-snacks",
    "cakes": "retail-snacks",
}

NEW_CATEGORIES = [
    ("retail-novelties", "Ice Cream Novelties", 106),
    ("retail-frozen-snacks", "Packaged Frozen Snacks", 109),
    ("retail-dairy-drinks", "Amul Dairy Drinks", 110),
    ("retail-dairy", "Amul Dairy Products", 111),
    ("retail-chocolates", "Amul Chocolates", 112),
    ("retail-snacks", "Amul Packaged Snacks", 113),
]


def sql(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    products = json.loads(SOURCE.read_text())
    if len(products) != 243 or len({p["sku"] for p in products}) != 243:
        raise ValueError("Expected 243 distinct reviewed products")
    lines = [
        "-- Reviewed Amul products from FrostFlow's curated catalogue.",
        "-- Printed MRP is a price candidate; café stock begins at zero and stays separate from ERP inventory.",
        "-- Missing MRPs remain price pending. Rerunning does not overwrite owner product edits.",
    ]
    for category_id, name, order in NEW_CATEGORIES:
        lines.append(
            "INSERT OR IGNORE INTO cafe_categories(id,name,sort_order,show_qr,show_pos,show_retail) "
            f"VALUES({sql(category_id)},{sql(name)},{order},0,1,1);"
        )
    used_categories = sorted({GROUP_CATEGORIES[p["group_id"]] for p in products})
    lines.append(
        "UPDATE cafe_categories SET show_qr=0,show_pos=1,show_retail=1,updated_at=CURRENT_TIMESTAMP "
        f"WHERE id IN ({','.join(map(sql, used_categories))});"
    )
    # The retail ice cream novelties belong in the existing free-fries offer.
    lines.append(
        "UPDATE cafe_promotions SET eligible_category_ids_json="
        + sql(json.dumps([
            "signature-sundaes", "build-your-own-sundae", "retail-cups", "retail-cones",
            "retail-bars", "retail-sticks", "retail-family-packs", "retail-tubs",
            "retail-multipacks", "retail-novelties",
        ], separators=(",", ":")))
        + " WHERE id='ice-cream-free-fries' AND eligible_category_ids_json="
        + sql('["signature-sundaes","build-your-own-sundae","retail-cups","retail-cones","retail-bars","retail-sticks","retail-family-packs","retail-tubs","retail-multipacks"]')
        + ";"
    )
    columns = (
        "id,category_id,name,description,type,image_url,price_paise,mrp_paise,sku,brand,"
        "pack_size,veg_type,available,active,track_stock,stock_quantity,prep_minutes,kitchen_route,"
        "prep_steps_json,sort_order"
    )
    category_order = {}
    for product in products:
        sku = product["sku"]
        category_id = GROUP_CATEGORIES[product["group_id"]]
        category_order[category_id] = category_order.get(category_id, 0) + 1
        price = product.get("mrp_paise")
        if price is not None and (not isinstance(price, int) or price <= 0 or price > 2_000_000):
            raise ValueError(f"Invalid MRP for {sku}")
        image = product.get("image") or ""
        if image and (not image.startswith("/images/") or "/" in image[len("/images/"):]):
            raise ValueError(f"Invalid image for {sku}")
        kind = product["department_id"]
        description = {
            "frozen": "Amul packaged ice cream" if product["category_id"] == "ice_creams" else "Amul packaged frozen snack",
            "dairy": "Amul packaged dairy product",
            "chocolates": "Amul packaged chocolate",
            "snacks": "Amul packaged snack",
        }[kind]
        steps = [
            "Pick the exact Amul pack and quantity shown on the order.",
            "Check the seal, expiry or best-before date, then confirm the order number at handover.",
        ]
        if kind == "frozen":
            steps.insert(1, "Keep frozen until handover; do not substitute another flavour or pack size.")
        values = [
            f"amul-{sku.lower()}", category_id, product["name"], description, "RETAIL", image,
            price or 0, price, sku, "Amul", product.get("unit_size") or "", "VEG",
            1 if price and not product.get("needs_review") else 0, 1, 1, 0, 5, 0,
            json.dumps(steps, ensure_ascii=False), category_order[category_id],
        ]
        lines.append(f"INSERT OR IGNORE INTO cafe_products({columns}) VALUES({','.join(map(sql, values))});")
    DESTINATION.write_text("\n".join(lines) + "\n")
    print(f"Wrote {len(products)} products to {DESTINATION}")


if __name__ == "__main__":
    main()

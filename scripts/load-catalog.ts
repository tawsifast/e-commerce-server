import { MongoClient, ServerApiVersion } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB || "my-shop";
const SELLER_ID = "6a6f9a683a016941fa4fd4ed"; // Marin Kitagawa
const SELLER_NAME = "Marin Kitagawa";

interface CatalogProduct {
  title: string;
  brand: string;
  category: string;
  price: number;
  discountPrice?: number;
  stock: number;
  images: string[];
  description: string;
  specifications?: Record<string, string>;
  createdAt: string;
  featured: boolean;
  sold: number;
}

const products: CatalogProduct[] = [
  // ---------- Electronics & Mobile ----------
  {
    title: "Aurora X5 Pro Smartphone",
    brand: "Aura Tech",
    category: "Mobile Phones",
    price: 699,
    discountPrice: 599,
    stock: 35,
    images: [
      "https://images.unsplash.com/photo-1598327105666-5b89351aff97?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Flagship 6.4-inch AMOLED phone with a 108MP camera, 5000mAh battery and 256GB storage. Unlocked for all carriers.",
    specifications: { Display: "6.4\" AMOLED", Camera: "108MP triple", Battery: "5000 mAh", Storage: "256 GB" },
    createdAt: "2026-07-02T10:00:00.000Z",
    featured: true,
    sold: 420,
  },
  {
    title: "Pulse Mini Bluetooth Speaker",
    brand: "Soundly",
    category: "Audio & Speakers",
    price: 49,
    discountPrice: 39,
    stock: 120,
    images: [
      "https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Pocket-sized speaker with 360° sound, IPX7 waterproofing and 12 hours of playtime. Pairs with any device in seconds.",
    specifications: { Battery: "12 h", Waterproof: "IPX7", Output: "10 W", Bluetooth: "5.3" },
    createdAt: "2026-07-05T09:00:00.000Z",
    featured: false,
    sold: 850,
  },
  {
    title: "PulseFit Smartwatch",
    brand: "VitalWear",
    category: "Wearables",
    price: 199,
    discountPrice: 169,
    stock: 60,
    images: [
      "https://images.unsplash.com/photo-1579586337278-3befd40fd17a?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1490367532201-b9bc1dc483f6?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Health-focused smartwatch with heart-rate, SpO2 and sleep tracking, GPS, and a week of battery life.",
    specifications: { Display: "1.43\" AMOLED", GPS: "Built-in", Battery: "7 days", "Water rating": "5 ATM" },
    createdAt: "2026-07-08T14:00:00.000Z",
    featured: true,
    sold: 700,
  },
  {
    title: "PowerCore 20K Power Bank",
    brand: "VoltSafe",
    category: "Chargers & Power",
    price: 39,
    stock: 150,
    images: [
      "https://images.unsplash.com/photo-1583863788434-e58a36330cf0?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1609592801494-0e18e2d44c72?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "20000mAh power bank with 22.5W fast charging, dual USB and USB-C ports. Charges a phone four times over.",
    specifications: { Capacity: "20000 mAh", Output: "22.5 W", Ports: "2x USB-A, 1x USB-C", Weight: "340 g" },
    createdAt: "2026-07-10T11:00:00.000Z",
    featured: false,
    sold: 990,
  },

  // ---------- Computers & PC ----------
  {
    title: "NovaBook Air 14 Laptop",
    brand: "NovaTech",
    category: "Laptops",
    price: 1099,
    discountPrice: 949,
    stock: 25,
    images: [
      "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Ultra-thin 14-inch laptop with a 2.8K display, 16GB RAM and 512GB SSD. Silent fanless design, all-day battery.",
    specifications: { Display: "14\" 2.8K", RAM: "16 GB", Storage: "512 GB SSD", Weight: "1.2 kg" },
    createdAt: "2026-07-12T08:30:00.000Z",
    featured: true,
    sold: 180,
  },
  {
    title: "Vertex Gaming Desktop",
    brand: "VertexPC",
    category: "Desktops",
    price: 1499,
    discountPrice: 1299,
    stock: 15,
    images: [
      "https://images.unsplash.com/photo-1591488320449-011701bb6704?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1587202372775-e229f172b9d7?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Ready-to-play gaming tower with RTX 4070, Ryzen 7 and 32GB DDR5. RGB cooling included.",
    specifications: { GPU: "RTX 4070", CPU: "Ryzen 7 7800X", RAM: "32 GB DDR5", Storage: "1 TB NVMe" },
    createdAt: "2026-07-15T15:00:00.000Z",
    featured: false,
    sold: 95,
  },
  {
    title: "Mechanical RGB Keyboard",
    brand: "KeyForge",
    category: "Peripherals",
    price: 89,
    discountPrice: 69,
    stock: 120,
    images: [
      "https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1618384887929-16ec33fab9ef?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Hot-swappable 75% mechanical keyboard with per-key RGB, PBT keycaps and a CNC aluminum frame.",
    specifications: { Layout: "75%", Switch: "Hot-swappable", Keycaps: "PBT", Connectivity: "USB-C" },
    createdAt: "2026-07-18T10:00:00.000Z",
    featured: false,
    sold: 460,
  },
  {
    title: "UltraView 27\" 4K Monitor",
    brand: "PixelPro",
    category: "Monitors & Displays",
    price: 349,
    discountPrice: 299,
    stock: 40,
    images: [
      "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1585790050230-5dd28404ccb9?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "27-inch 4K IPS monitor with 95% DCI-P3, USB-C power delivery and ultra-slim bezels. Ideal for creatives.",
    specifications: { Panel: "27\" IPS 4K", Color: "95% DCI-P3", Ports: "2x HDMI, DP, USB-C", Refresh: "60 Hz" },
    createdAt: "2026-07-20T12:00:00.000Z",
    featured: true,
    sold: 210,
  },
  {
    title: "ErgoCool Laptop Stand",
    brand: "DeskCraft",
    category: "PC Accessories",
    price: 29,
    stock: 150,
    images: [
      "https://images.unsplash.com/photo-1612240498936-65f5101365d2?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1495727034151-8fdc73e843a8?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Aluminium ergonomic laptop stand with 7 height settings and ventilation cutouts for cooler, comfier typing.",
    specifications: { Material: "Aluminium", Settings: "7 heights", Fits: "Up to 17\"", Weight: "680 g" },
    createdAt: "2026-07-22T09:00:00.000Z",
    featured: false,
    sold: 380,
  },

  // ---------- Fashion & Apparel ----------
  {
    title: "Floral Midi Wrap Dress",
    brand: "Luna & Rose",
    category: "Dresses",
    price: 89,
    discountPrice: 69,
    stock: 45,
    images: [
      "https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Flattering midi wrap dress in a soft floral print. Viscose blend with a tie waist — sizes XS to XL.",
    specifications: { Fit: "Wrap", Length: "Midi", Material: "Viscose blend", Sizes: "XS–XL" },
    createdAt: "2026-07-24T13:00:00.000Z",
    featured: true,
    sold: 320,
  },
  {
    title: "Silk-Cotton Blouse",
    brand: "Luna & Co",
    category: "Tops & Blouses",
    price: 59,
    discountPrice: 49,
    stock: 70,
    images: [
      "https://images.unsplash.com/photo-1434389677669-e08b4cac3105?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1554568218-0f1715e72254?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Crisp silk-cotton blouse with a relaxed cut and mother-of-pearl buttons. Machine washable.",
    specifications: { Material: "60% silk, 40% cotton", Fit: "Relaxed", Care: "Machine wash", Sizes: "XS–XL" },
    createdAt: "2026-07-26T10:00:00.000Z",
    featured: false,
    sold: 240,
  },
  {
    title: "Oxford Stretch Shirt",
    brand: "Treads & Co",
    category: "Men's Shirts",
    price: 49,
    discountPrice: 39,
    stock: 90,
    images: [
      "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1598033129183-c4f50c736f10?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Classic oxford shirt with a touch of stretch that keeps its shape all day. Wrinkle-resistant cotton.",
    specifications: { Material: "Cotton stretch", Fit: "Slim", Collar: "Button-down", Sizes: "S–XXL" },
    createdAt: "2026-07-27T16:00:00.000Z",
    featured: false,
    sold: 410,
  },
  {
    title: "Slim Fit Straight Jeans",
    brand: "Denim Theory",
    category: "Pants & Jeans",
    price: 69,
    discountPrice: 55,
    stock: 85,
    images: [
      "https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1473966968600-fa801b869a1a?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Stretch denim straight-leg jeans with a mid rise and just the right amount of taper. Dark indigo wash.",
    specifications: { Fit: "Slim straight", Rise: "Mid", Wash: "Dark indigo", Sizes: "28–38" },
    createdAt: "2026-07-28T11:00:00.000Z",
    featured: true,
    sold: 510,
  },
  {
    title: "Water-Resistant Denim Jacket",
    brand: "Harbor & Stone",
    category: "Jackets & Outerwear",
    price: 99,
    discountPrice: 79,
    stock: 55,
    images: [
      "https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1548122618-079a0fb0099d?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Classic trucker jacket in water-repellent denim with a soft brushed lining. A forever piece.",
    specifications: { Material: "Denim, water-repellent", Lining: "Brushed cotton", Fit: "Regular", Sizes: "S–XXL" },
    createdAt: "2026-07-29T09:30:00.000Z",
    featured: false,
    sold: 260,
  },

  // ---------- Shoes ----------
  {
    title: "CloudStep Running Sneakers",
    brand: "Stride Labs",
    category: "Sneakers",
    price: 95,
    discountPrice: 75,
    stock: 100,
    images: [
      "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Featherlight running shoes with a bouncy foam midsole and breathable knit upper. True to size.",
    specifications: { Midsole: "CloudFoam", Upper: "Engineered knit", Weight: "240 g", Sizes: "EU 36–46" },
    createdAt: "2026-07-30T10:00:00.000Z",
    featured: true,
    sold: 640,
  },
  {
    title: "Oxford Leather Shoes",
    brand: "Claxton",
    category: "Formal Shoes",
    price: 120,
    discountPrice: 95,
    stock: 45,
    images: [
      "https://images.unsplash.com/photo-1543163521-1bf539c55dd2?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Hand-finished full-grain leather oxfords with a Goodyear welt. Polishes to a mirror shine.",
    specifications: { Leather: "Full-grain", Sole: "Goodyear welt", Color: "Black", Sizes: "EU 39–46" },
    createdAt: "2026-07-31T12:00:00.000Z",
    featured: false,
    sold: 170,
  },
  {
    title: "Chelsea Boot — Tan",
    brand: "Earnshaw",
    category: "Boots",
    price: 140,
    discountPrice: 115,
    stock: 38,
    images: [
      "https://images.unsplash.com/photo-1608256246200-53e635b5b65f?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1520639888713-7851133b1ed0?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Elastic-side chelsea boots in soft tan leather with a chunky rubber sole. Comfortable from day one.",
    specifications: { Leather: "Nubuck", Sole: "Rubber", Color: "Tan", Sizes: "EU 39–46" },
    createdAt: "2026-08-01T09:00:00.000Z",
    featured: false,
    sold: 190,
  },
  {
    title: "Nimbus Cloud Slides",
    brand: "Breeze Sole",
    category: "Sandals & Slippers",
    price: 30,
    discountPrice: 22,
    stock: 75,
    images: [
      "https://images.unsplash.com/photo-1603487742131-4160ec999306?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1562279684-1fcabf915e2b?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Cloud-soft foam slides with arch support and a water-friendly build. Slip on, go anywhere.",
    specifications: { Material: "EVA foam", Support: "Arch", Waterproof: "Yes", Sizes: "EU 36–46" },
    createdAt: "2026-08-02T14:00:00.000Z",
    featured: false,
    sold: 330,
  },

  // ---------- Home & Living ----------
  {
    title: "Stainless Cookware Set",
    brand: "Hearthstone",
    category: "Kitchen & Dining",
    price: 199,
    discountPrice: 159,
    stock: 25,
    images: [
      "https://images.unsplash.com/photo-1584992236310-6edddc08acff?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "10-piece tri-ply stainless cookware set with riveted handles. Induction ready, oven safe to 260°C.",
    specifications: { Pieces: "10", Ply: "Tri-ply", "Oven safe": "260°C", "Dishwasher safe": "Yes" },
    createdAt: "2026-07-03T10:00:00.000Z",
    featured: true,
    sold: 120,
  },
  {
    title: "Pendant Tree Floor Lamp",
    brand: "Lumen & Co",
    category: "Decor & Lighting",
    price: 89,
    discountPrice: 69,
    stock: 30,
    images: [
      "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Three-bulb arc floor lamp with warm linen shades and a dimmable foot switch. Soft, sculptural light.",
    specifications: { Bulbs: "3 x E27", Height: "180 cm", Switch: "Dimmable foot", Material: "Steel + linen" },
    createdAt: "2026-07-06T15:00:00.000Z",
    featured: false,
    sold: 150,
  },
  {
    title: "Cozy Linen Bedding Set",
    brand: "Flora Home",
    category: "Bedding & Bath",
    price: 119,
    discountPrice: 95,
    stock: 45,
    images: [
      "https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1540518614846-7eded433c457?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Stonewashed European flax linen duvet set that gets softer with every wash. Queen size, sand colour.",
    specifications: { Size: "Queen", Material: "100% linen", Includes: "Duvet cover + 2 pillowcases", Care: "Machine wash" },
    createdAt: "2026-07-09T11:00:00.000Z",
    featured: false,
    sold: 88,
  },
  {
    title: "Modern Accent Chair",
    brand: "Nook & Co",
    category: "Furniture",
    price: 249,
    discountPrice: 199,
    stock: 12,
    images: [
      "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Mid-century accent chair in bouclé fabric with solid oak legs. Ships flat-pack, assembles in 10 minutes.",
    specifications: { Fabric: "Bouclé", Frame: "Solid oak", Width: "72 cm", Weight: "14 kg" },
    createdAt: "2026-07-14T10:00:00.000Z",
    featured: false,
    sold: 45,
  },

  // ---------- Other ----------
  {
    title: "Build-It Wooden Block Set",
    brand: "WoodZone",
    category: "Toys & Games",
    price: 45,
    discountPrice: 35,
    stock: 100,
    images: [
      "https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "120-piece natural beech block set in a cotton storage bag. Certified safe for ages 3+.",
    specifications: { Pieces: "120", Material: "Beech wood", Ages: "3+", Includes: "Storage bag" },
    createdAt: "2026-07-16T13:00:00.000Z",
    featured: false,
    sold: 700,
  },
  {
    title: "Leather Journal & Pen Set",
    brand: "Ink & Quill",
    category: "Stationery",
    price: 29,
    discountPrice: 23,
    stock: 130,
    images: [
      "https://images.unsplash.com/photo-1452860606245-08befc0ff44b?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Refillable leather-bound journal with 160 pages of 120gsm paper, plus a matching rollerball pen.",
    specifications: { Pages: "160", Paper: "120 gsm", Cover: "Full-grain leather", Pen: "Rollerball" },
    createdAt: "2026-07-19T09:00:00.000Z",
    featured: false,
    sold: 520,
  },
  {
    title: "Foldable Yoga Mat",
    brand: "FlexFlow",
    category: "Sports & Fitness",
    price: 35,
    discountPrice: 28,
    stock: 160,
    images: [
      "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "6mm non-slip yoga mat with alignment lines and a foldable carry strap. Free of PVC and latex.",
    specifications: { Thickness: "6 mm", Material: "TPE", Includes: "Carry strap", "Non-slip": "Yes" },
    createdAt: "2026-07-21T12:00:00.000Z",
    featured: false,
    sold: 680,
  },
  {
    title: "The Art of Slow Living",
    brand: "Nugget Press",
    category: "Books",
    price: 22,
    discountPrice: 17,
    stock: 200,
    images: [
      "https://images.unsplash.com/photo-1544947950-fa07a3454f18?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1493745985815-b4522c2b2f0e?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "A beautifully illustrated guide to slowing down — seasonal routines, simple rituals and small joys.",
    specifications: { Pages: "240", Format: "Hardcover", Publisher: "Nugget Press", Language: "English" },
    createdAt: "2026-07-23T10:00:00.000Z",
    featured: true,
    sold: 840,
  },
  {
    title: "Everyday Canvas Backpack",
    brand: "Wayfellow",
    category: "Bags & Accessories",
    price: 65,
    discountPrice: 49,
    stock: 85,
    images: [
      "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80",
      "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80",
    ],
    description:
      "Waxed canvas backpack with a 16\" laptop sleeve, leather trims and a weatherproof roll-top.",
    specifications: { Capacity: "24 L", Laptop: "16\" sleeve", Material: "Waxed canvas", Closure: "Roll-top" },
    createdAt: "2026-07-25T15:00:00.000Z",
    featured: false,
    sold: 290,
  },
];

const client = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function main() {
  await client.connect();
  const db = client.db(DB_NAME);

  const docs = products.map((p) => ({
    title: p.title,
    brand: p.brand,
    category: p.category,
    price: p.price,
    discountPrice: p.discountPrice ?? null,
    stock: p.stock,
    images: p.images,
    description: p.description,
    specifications: p.specifications,
    sellerId: SELLER_ID,
    sellerName: SELLER_NAME,
    createdAt: new Date(p.createdAt),
    featured: p.featured,
    sold: p.sold,
  }));

  const existing = await db
    .collection("products")
    .countDocuments({ title: { $in: docs.map((d) => d.title) } });
  if (existing > 0) {
    console.log(`Aborting: ${existing} product(s) with the same title already exist.`);
    process.exit(1);
  }

  const res = await db.collection("products").insertMany(docs);
  console.log(`Inserted ${res.insertedCount} products`);

  const total = await db.collection("products").countDocuments();
  const cats = await db
    .collection("products")
    .aggregate([{ $group: { _id: "$category", n: { $sum: 1 } } }])
    .toArray();
  console.log(`Total products now: ${total}`);
  console.log(
    "Categories: " +
      cats
        .map((c) => `${c._id} (${c.n})`)
        .sort()
        .join(", ")
  );

  await client.close();
}

main().catch((err) => {
  console.error("Load failed:", err);
  process.exit(1);
});

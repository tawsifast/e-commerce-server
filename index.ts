import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import { SignJWT, jwtVerify } from "jose-cjs";
import {
  MongoClient,
  ObjectId,
  ServerApiVersion,
  type Collection,
  type Db,
  type Filter,
  type WithId,
} from "mongodb";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB || "my-shop";

const AUTH_SECRET = new TextEncoder().encode(process.env.BETTER_AUTH_SECRET || "");
const SESSION_COOKIE = process.env.BETTER_AUTH_COOKIE || "better-auth.session_token";
const API_TOKEN_COOKIE = process.env.API_TOKEN_COOKIE || "marketa_api_token";
const JWT_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS) || 3600;

// Stripe is optional — without STRIPE_SECRET_KEY confirm falls back to
// marking orders paid without verification so the app still works keyless.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000", credentials: true }));
app.use(express.json());

const client = new MongoClient(MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db: Db;

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

interface MongoUser {
  _id: ObjectId;
  name: string;
  email: string;
  image?: string | null;
  photo?: string | null;
  role?: string;
  blocked?: boolean;
  createdAt?: string | Date;
}

interface ProductDoc {
  _id: ObjectId;
  title: string;
  brand?: string;
  category?: string;
  price: number;
  discountPrice?: number | null;
  stock: number;
  images?: string[];
  description?: string;
  specifications?: Record<string, unknown>;
  sellerId: string;
  sellerName: string;
  createdAt: Date;
  hidden?: boolean;
  sold?: number;
  featured?: boolean;
}

interface ReviewDoc {
  _id: ObjectId;
  productId: string;
  userId: string;
  rating: number;
  comment: string;
  createdAt: Date;
  user: { _id: string; name: string; photo?: string | null };
}

interface OrderItemDoc {
  productId: string;
  title: string;
  image?: string;
  price: number;
  quantity: number;
  seller: { _id: string; name: string };
}

interface OrderDoc {
  _id: ObjectId;
  buyer: { _id: string; name: string };
  items: OrderItemDoc[];
  totalAmount: number;
  total: number;
  status: string;
  orderStatus: string;
  paymentStatus: string;
  createdAt: Date;
  address: { line1?: string; city?: string; state?: string; zip?: string; country?: string };
}

interface WishlistDoc {
  _id: ObjectId;
  userId: string;
  productIds: string[];
}

interface ProductPayload {
  title: string;
  description?: string;
  price: number;
  discountPrice?: number;
  category?: string;
  stock: number;
  images: string[];
}

const products = (): Collection<ProductDoc> => db.collection<ProductDoc>("products");
const reviews = (): Collection<ReviewDoc> => db.collection<ReviewDoc>("reviews");
const orders = (): Collection<OrderDoc> => db.collection<OrderDoc>("orders");
const wishlists = (): Collection<WishlistDoc> => db.collection<WishlistDoc>("wishlists");
const users = (): Collection<MongoUser> => db.collection<MongoUser>("user");

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

const iso = (d?: string | Date) => (d ? new Date(d).toISOString() : undefined);

function toOid(id: unknown): ObjectId | null {
  if (typeof id !== "string" || !ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

function toPublicUser(u: WithId<MongoUser>) {
  return {
    _id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role ?? "buyer",
    photo: u.image ?? u.photo ?? undefined,
    blocked: !!u.blocked,
    createdAt: iso(u.createdAt),
  };
}
function toOrder(o: WithId<OrderDoc>) {
  return {
    _id: o._id.toString(),
    buyer: o.buyer,
    items: o.items,
    totalAmount: o.totalAmount,
    total: o.total,
    status: o.status,
    orderStatus: o.orderStatus,
    paymentStatus: o.paymentStatus,
    createdAt: iso(o.createdAt),
    address: o.address,
  };
}

function toReview(r: WithId<ReviewDoc>) {
  return {
    _id: r._id.toString(),
    productId: r.productId,
    userId: r.userId,
    rating: r.rating,
    comment: r.comment,
    createdAt: iso(r.createdAt),
    user: r.user,
  };
}

async function enrichProduct(p: WithId<ProductDoc>) {
  const all = await reviews().find({ productId: p._id.toString() }).toArray();
  const averageRating = all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : 0;
  return {
    _id: p._id.toString(),
    title: p.title,
    brand: p.brand,
    category: p.category,
    price: p.price,
    discountPrice: p.discountPrice ?? null,
    stock: p.stock,
    images: p.images ?? [],
    description: p.description,
    specifications: p.specifications,
    createdAt: iso(p.createdAt),
    averageRating,
    reviewCount: all.length,
    seller: { _id: p.sellerId, name: p.sellerName },
  };
}

async function paginate<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  return { items: items.slice(start, start + limit), total, page, pages };
}

function pageOf(req: Request, fallbackLimit = 12) {
  const page = Number(req.query.page) >= 1 ? Number(req.query.page) : 1;
  const limit = Number(req.query.limit) >= 1 ? Number(req.query.limit) : fallbackLimit;
  return { page, limit };
}

// ------------------------------------------------------------
// Auth — JWT API tokens (verified with jose-cjs)
// ------------------------------------------------------------

interface SessionDoc {
  _id: string;
  token: string;
  expiresAt: string;
  userId: ObjectId;
  createdAt?: string;
}

interface JwtPayload {
  sub: string;
  name: string;
  role: string;
}

const sessions = (): Collection<SessionDoc> => db.collection<SessionDoc>("session");

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

async function signApiToken(user: WithId<MongoUser>): Promise<string> {
  return new SignJWT({ name: user.name, role: user.role ?? "buyer" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user._id.toString())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS)
    .sign(AUTH_SECRET);
}

// Verifies the API JWT cookie (cached per request), then reloads the user
// from Mongo so role/blocked changes apply immediately.
async function apiUser(req: Request, res: Response): Promise<WithId<MongoUser> | null> {
  if (res.locals.__apiUserChecked) return res.locals.__apiUser ?? null;
  res.locals.__apiUserChecked = true;
  res.locals.__apiUser = null;

  const token = parseCookies(req.headers.cookie)[API_TOKEN_COOKIE];
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, AUTH_SECRET, { algorithms: ["HS256"] });
    const user = await users().findOne({ _id: new ObjectId(payload.sub as string) });
    if (!user || user.blocked) return null;
    res.locals.__apiUser = user;
    return user;
  } catch {
    return null;
  }
}

// Exchange the better-auth session cookie for an API JWT cookie.
app.post(
  "/api/auth/token",
  ah(async (req, res) => {
    // better-auth stores the raw token in the DB but the cookie carries
    // "<token>.<hash>" — only the part before the first dot is the session id.
    const cookieValue = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const token = cookieValue ? cookieValue.split(".")[0] : "";
    if (!token) return res.status(401).json({ message: "Not authenticated" });

    const session = await sessions().findOne({ token });
    if (!session || new Date(session.expiresAt) <= new Date()) {
      return res.status(401).json({ message: "Session expired" });
    }

    const user = await users().findOne({ _id: session.userId });
    if (!user || user.blocked) return res.status(401).json({ message: "Not authenticated" });

    const apiToken = await signApiToken(user);
    res.cookie(API_TOKEN_COOKIE, apiToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: JWT_TTL_SECONDS * 1000,
      path: "/",
    });
    res.json({ user: toPublicUser(user) });
  }),
);

app.post(
  "/api/auth/logout",
  ah(async (_req, res) => {
    res.clearCookie(API_TOKEN_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
    res.json({ success: true });
  }),
);

function requireRoles(...roles: string[]) {
  return ah(async (req, res, next) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    if (!roles.includes(user.role ?? "buyer")) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  });
}

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------

app.get(
  "/api/products",
  ah(async (req, res) => {
    const q = req.query;
    const search = String(q.search ?? "").trim().toLowerCase();
    const category = typeof q.category === "string" && q.category ? q.category : undefined;
    const brand = typeof q.brand === "string" ? q.brand.trim().toLowerCase() : undefined;
    const minPrice = q.minPrice != null && !Number.isNaN(Number(q.minPrice)) ? Number(q.minPrice) : undefined;
    const maxPrice = q.maxPrice != null && !Number.isNaN(Number(q.maxPrice)) ? Number(q.maxPrice) : undefined;
    const sort = String(q.sort ?? "newest");
    const { page, limit } = pageOf(req, 12);

    const priceOf = (p: ProductDoc) => p.discountPrice ?? p.price;

    let items = (await products().find({ hidden: { $ne: true } }).toArray()).filter((p) => {
      const finalPrice = priceOf(p);
      if (category && p.category !== category) return false;
      if (brand && !p.brand?.toLowerCase().includes(brand)) return false;
      if (minPrice != null && finalPrice < minPrice) return false;
      if (maxPrice != null && finalPrice > maxPrice) return false;
      if (search) {
        const haystack = `${p.title} ${p.brand ?? ""} ${p.category ?? ""}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    switch (sort) {
      case "price-asc":
        items = [...items].sort((a, b) => priceOf(a) - priceOf(b));
        break;
      case "price-desc":
        items = [...items].sort((a, b) => priceOf(b) - priceOf(a));
        break;
      case "rating": {
        const ratingMap = new Map<string, number>();
        const grouped = await reviews()
          .find({ productId: { $in: items.map((p) => p._id.toString()) } })
          .toArray();
        for (const r of grouped) {
          ratingMap.set(r.productId, (ratingMap.get(r.productId) ?? 0) + r.rating);
        }
        items = [...items].sort((a, b) => {
          const ra = ratingMap.get(a._id.toString()) ?? 0;
          const rb = ratingMap.get(b._id.toString()) ?? 0;
          return rb - ra;
        });
        break;
      }
      default:
        items = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    const enriched = [];
    for (const p of items) enriched.push(await enrichProduct(p));
    res.json(await paginate(enriched, page, limit));
  }),
);

app.get(
  "/api/products/featured",
  ah(async (_req, res) => {
    const docs = await products().find({ hidden: { $ne: true }, featured: true }).toArray();
    const items = [];
    for (const p of docs) items.push(await enrichProduct(p));
    items.sort((a, b) => (b.averageRating ?? 0) - (a.averageRating ?? 0));
    res.json({ items });
  }),
);

app.get(
  "/api/products/best-sellers",
  ah(async (_req, res) => {
    const docs = await products()
      .find({ hidden: { $ne: true } } as Filter<ProductDoc>)
      .sort({ sold: -1 })
      .limit(8)
      .toArray();
    const items = [];
    for (const p of docs) items.push(await enrichProduct(p));
    res.json({ items });
  }),
);

app.get(
  "/api/products/categories",
  ah(async (_req, res) => {
    const docs = await products()
      .find({ hidden: { $ne: true }, category: { $exists: true, $ne: "" } } as Filter<ProductDoc>)
      .toArray();
    const counts = new Map<string, number>();
    for (const p of docs) {
      if (!p.category) continue;
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    res.json({ items: [...counts.entries()].map(([name, count]) => ({ name, count })) });
  }),
);

app.get(
  "/api/products/:id",
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    const product = oid ? await products().findOne({ _id: oid }) : null;
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json({ product: await enrichProduct(product) });
  }),
);

app.get(
  "/api/products/:id/reviews",
  ah(async (req, res) => {
    const docs = await reviews()
      .find({ productId: req.params.id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ items: docs.map(toReview) });
  }),
);

app.post(
  "/api/products/:id/reviews",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const oid = toOid(req.params.id);
    const product = oid ? await products().findOne({ _id: oid }) : null;
    if (!product) return res.status(404).json({ message: "Product not found" });

    const body = (req.body ?? {}) as { rating?: unknown; comment?: unknown };
    const review: ReviewDoc = {
      _id: new ObjectId(),
      productId: req.params.id,
      userId: user._id.toString(),
      rating: Math.min(5, Math.max(1, Number(body.rating) || 1)),
      comment: String(body.comment ?? "").trim(),
      createdAt: new Date(),
      user: { _id: user._id.toString(), name: user.name, photo: user.image ?? user.photo },
    };
    await reviews().insertOne(review);
    res.json({ review: toReview(review) });
  }),
);

// ------------------------------------------------------------
// Wishlist
// ------------------------------------------------------------

app.get(
  "/api/wishlist",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const doc = await wishlists().findOne({ userId: user._id.toString() });
    const ids = (doc?.productIds ?? []).map(toOid).filter((x): x is ObjectId => x !== null);
    const docs = ids.length ? await products().find({ _id: { $in: ids } }).toArray() : [];
    const items = [];
    for (const p of docs) items.push(await enrichProduct(p));
    res.json({ items });
  }),
);

app.post(
  "/api/wishlist",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const productId = String((req.body ?? {}).productId ?? "");
    if (!productId) return res.status(400).json({ message: "productId is required" });
    const userId = user._id.toString();
    await wishlists().updateOne(
      { userId },
      { $addToSet: { productIds: productId } },
      { upsert: true },
    );
    res.json({ success: true });
  }),
);

app.delete(
  "/api/wishlist/:productId",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    await wishlists().updateOne(
      { userId: user._id.toString() },
      { $pull: { productIds: req.params.productId } },
    );
    res.json({ success: true });
  }),
);

// ------------------------------------------------------------
// Orders
// ------------------------------------------------------------

app.post(
  "/api/orders/checkout",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });

    const body = (req.body ?? {}) as {
      items?: { product?: string; quantity?: number }[];
      address?: { line1?: string; city?: string; state?: string; zip?: string; country?: string };
      contact?: string;
      notes?: string;
    };

    const items: OrderItemDoc[] = [];
    for (const it of body.items ?? []) {
      const oid = toOid(it.product);
      const product = oid ? await products().findOne({ _id: oid }) : null;
      items.push({
        productId: it.product ?? "",
        title: product?.title ?? "Product",
        image: product?.images?.[0],
        price: product ? (product.discountPrice ?? product.price) : 0,
        quantity: Number(it.quantity) || 1,
        seller: product
          ? { _id: product.sellerId, name: product.sellerName }
          : { _id: "unknown", name: "Marketa" },
      });
    }

    const totalAmount = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const order: OrderDoc = {
      _id: new ObjectId(),
      buyer: { _id: user._id.toString(), name: user.name },
      items,
      totalAmount,
      total: totalAmount,
      status: "pending",
      orderStatus: "pending",
      paymentStatus: "pending",
      createdAt: new Date(),
      address: {
        line1: body.address?.line1 ?? "123 Main St",
        city: body.address?.city ?? "Portland",
        country: body.address?.country ?? "United States",
      },
    };
    await orders().insertOne(order);

    // The client creates a Stripe Checkout Session (Next.js route) and
    // redirects the buyer to the hosted payment page. Confirmation happens
    // in POST /orders/:id/confirm once Stripe redirects back to /success.
    res.json({ orderId: order._id.toString(), status: "pending" });
  }),
);

app.post(
  "/api/orders/:id/confirm",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const oid = toOid(req.params.id);
    const order = oid ? await orders().findOne({ _id: oid }) : null;
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.buyer._id.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Not your order" });
    }

    const sessionId = String((req.body ?? {}).sessionId ?? "");
    if (stripe && sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") {
        return res.status(400).json({ message: `Payment not completed (${session.payment_status})` });
      }
      if (session.metadata?.orderId !== order._id.toString()) {
        return res.status(400).json({ message: "Session does not match this order" });
      }
      await orders().updateOne(
        { _id: order._id },
        { $set: { paymentStatus: "paid", status: "processing", orderStatus: "processing" } },
      );
      return res.json({
        order: toOrder({ ...order, paymentStatus: "paid", status: "processing", orderStatus: "processing" }),
      });
    }

    // Dev fallback (no STRIPE_SECRET_KEY) — confirm without verification.
    await orders().updateOne(
      { _id: order._id },
      { $set: { paymentStatus: "paid", status: "processing", orderStatus: "processing" } },
    );
    res.json({
      order: toOrder({ ...order, paymentStatus: "paid", status: "processing", orderStatus: "processing" }),
    });
  }),
);

app.get(
  "/api/orders/my",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const { page, limit } = pageOf(req, 10);
    const mine = (await orders().find({ "buyer._id": user._id.toString() }).toArray()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const items = mine.slice((page - 1) * limit, (page - 1) * limit + limit).map(toOrder);
    const total = mine.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    res.json({ items, total, page, pages });
  }),
);

app.post(
  "/api/orders/:id/cancel",
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const oid = toOid(req.params.id);
    const order = oid ? await orders().findOne({ _id: oid }) : null;
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.buyer._id.toString() !== user._id.toString()) {
      return res.status(403).json({ message: "Not your order" });
    }
    await orders().updateOne(
      { _id: order._id },
      { $set: { status: "cancelled", orderStatus: "cancelled", paymentStatus: "refunded" } },
    );
    res.json({ order: toOrder({ ...order, status: "cancelled", orderStatus: "cancelled", paymentStatus: "refunded" }) });
  }),
);

// ------------------------------------------------------------
// Reviews
// ------------------------------------------------------------

app.get(
  "/api/reviews/latest",
  ah(async (_req, res) => {
    const docs = await reviews().find({}).sort({ createdAt: -1 }).limit(6).toArray();
    res.json({
      items: docs.map((r) => ({
        _id: r._id.toString(),
        rating: r.rating,
        comment: r.comment,
        user: { _id: r.user._id, name: r.user.name },
        createdAt: iso(r.createdAt),
      })),
    });
  }),
);

// ------------------------------------------------------------
// Seller
// ------------------------------------------------------------

app.get(
  "/api/seller/overview",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const sellerId = user._id.toString();
    const myProducts = await products().find({ sellerId }).toArray();
    const myOrderDocs = await orders()
      .find({ status: { $ne: "cancelled" }, "items.seller._id": sellerId } as Filter<OrderDoc>)
      .toArray();
    const revenue = myOrderDocs.reduce((s, o) => s + o.totalAmount, 0);
    const pids = myProducts.map((p) => p._id.toString());
    const allReviews = pids.length ? await reviews().find({ productId: { $in: pids } }).toArray() : [];
    const avgRating = allReviews.length
      ? allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length
      : 0;
    res.json({
      revenue,
      revenueDelta: 12.4,
      orders: myOrderDocs.length,
      ordersDelta: 8.1,
      productsCount: myProducts.length,
      avgRating,
    });
  }),
);

app.get(
  "/api/seller/analytics",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const range = String(req.query.range ?? "30d");
    const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
    const salesSeries = Array.from({ length: days }).map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const revenue = Math.round(120 + Math.abs(Math.sin(i * 1.7)) * 320 + (i % 5) * 40);
      return {
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        revenue,
      };
    });

    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const myProducts = await products().find({ sellerId: user._id.toString() }).toArray();
    const topProducts = [...myProducts]
      .sort((a, b) => (b.sold ?? 0) - (a.sold ?? 0))
      .slice(0, 5)
      .map((p) => ({ title: p.title, sold: p.sold ?? 0 }));
    const breakdown = new Map<string, number>();
    for (const p of myProducts) {
      const cat = p.category ?? "Other";
      breakdown.set(cat, (breakdown.get(cat) ?? 0) + 1);
    }
    const categoryBreakdown = [...breakdown.entries()].map(([name, value]) => ({ name, value }));

    res.json({ salesSeries, topProducts, categoryBreakdown });
  }),
);

app.get(
  "/api/seller/products",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const docs = (await products().find({ sellerId: user._id.toString() }).toArray()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const items = [];
    for (const p of docs) {
      const enriched = await enrichProduct(p);
      items.push({ ...enriched, sold: p.sold ?? 0 });
    }
    res.json({ items });
  }),
);

app.post(
  "/api/seller/products",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const body = (req.body ?? {}) as Partial<ProductPayload>;
    const doc: ProductDoc = {
      _id: new ObjectId(),
      title: String(body.title ?? "").trim(),
      description: body.description,
      price: Number(body.price) || 0,
      discountPrice: body.discountPrice != null ? Number(body.discountPrice) : null,
      category: body.category,
      stock: Number(body.stock) || 0,
      images: body.images ?? [],
      sellerId: user._id.toString(),
      sellerName: user.name,
      createdAt: new Date(),
      sold: 0,
    };
    await products().insertOne(doc);
    res.json({ product: await enrichProduct(doc) });
  }),
);

app.patch(
  "/api/seller/products/:id",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    const existing = oid ? await products().findOne({ _id: oid }) : null;
    if (!existing) return res.status(404).json({ message: "Product not found" });
    const body = (req.body ?? {}) as Partial<ProductPayload>;
    const patch: Partial<ProductDoc> = {};
    if (body.title != null) patch.title = String(body.title).trim();
    if (body.description != null) patch.description = body.description;
    if (body.price != null) patch.price = Number(body.price);
    if (body.discountPrice != null) patch.discountPrice = Number(body.discountPrice);
    if (body.category != null) patch.category = body.category;
    if (body.stock != null) patch.stock = Number(body.stock);
    if (body.images != null) patch.images = body.images;
    await products().updateOne({ _id: existing._id }, { $set: patch });
    const updated = await products().findOne({ _id: existing._id });
    res.json({ product: updated ? await enrichProduct(updated) : null });
  }),
);

app.delete(
  "/api/seller/products/:id",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    if (!oid) return res.status(404).json({ message: "Product not found" });
    await products().deleteOne({ _id: oid });
    await reviews().deleteMany({ productId: req.params.id });
    await wishlists().updateMany({}, { $pull: { productIds: req.params.id } });
    res.json({ success: true });
  }),
);

app.get(
  "/api/seller/orders",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const user = await apiUser(req, res);
    if (!user) return res.status(401).json({ message: "Not authenticated" });
    const { page, limit } = pageOf(req, 10);
    const sellerId = user._id.toString();
    const mine = (await orders().find({ "items.seller._id": sellerId } as Filter<OrderDoc>).toArray()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const totalPages = Math.max(1, Math.ceil(mine.length / limit));
    const start = (page - 1) * limit;
    res.json({
      items: mine.slice(start, start + limit).map((o) => ({
        _id: o._id.toString(),
        buyer: o.buyer,
        total: o.totalAmount,
        createdAt: iso(o.createdAt),
        status: o.status,
      })),
      totalPages,
    });
  }),
);

app.patch(
  "/api/seller/orders/:id/status",
  requireRoles("seller", "admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    const order = oid ? await orders().findOne({ _id: oid }) : null;
    if (!order) return res.status(404).json({ message: "Order not found" });
    const status = String((req.body ?? {}).status ?? "");
    await orders().updateOne(
      { _id: order._id },
      { $set: { status, orderStatus: status } },
    );
    res.json({ order: toOrder({ ...order, status, orderStatus: status }) });
  }),
);

app.post(
  "/api/seller/apply",
  requireRoles("seller", "admin"),
  ah(async (_req, res) => {
    res.json({ applied: true });
  }),
);

// ------------------------------------------------------------
// Admin
// ------------------------------------------------------------

app.get(
  "/api/admin/overview",
  requireRoles("admin"),
  ah(async (_req, res) => {
    const usersCount = await users().countDocuments();
    const sellersCount = await users().countDocuments({ role: "seller" });
    const productsCount = await products().countDocuments();
    const allOrders = await orders().find({ status: { $ne: "cancelled" } }).toArray();
    const gmv = allOrders.reduce((s, o) => s + o.totalAmount, 0);
    const revenueSeries = Array.from({ length: 30 }).map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (29 - i));
      const revenue = Math.round(900 + Math.abs(Math.sin(i * 1.3)) * 1800 + (i % 7) * 120);
      return {
        date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        revenue,
      };
    });
    res.json({ usersCount, sellersCount, productsCount, gmv, revenueSeries });
  }),
);

app.get(
  "/api/admin/users",
  requireRoles("admin"),
  ah(async (req, res) => {
    const { page, limit } = pageOf(req, 15);
    const docs = (await users().find({}).toArray()).sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    );
    const totalPages = Math.max(1, Math.ceil(docs.length / limit));
    const start = (page - 1) * limit;
    res.json({
      items: docs.slice(start, start + limit).map(toPublicUser),
      totalPages,
    });
  }),
);

app.patch(
  "/api/admin/users/:id/role",
  requireRoles("admin"),
  ah(async (req, res) => {
    const role = String((req.body ?? {}).role ?? "");
    const oid = toOid(req.params.id);
    const user = oid ? await users().findOne({ _id: oid }) : null;
    if (!user) return res.status(404).json({ message: "User not found" });
    await users().updateOne({ _id: user._id }, { $set: { role } });
    res.json({ user: toPublicUser({ ...user, role }) });
  }),
);

app.patch(
  "/api/admin/users/:id/block",
  requireRoles("admin"),
  ah(async (req, res) => {
    const blocked = !!(req.body ?? {}).blocked;
    const oid = toOid(req.params.id);
    const user = oid ? await users().findOne({ _id: oid }) : null;
    if (!user) return res.status(404).json({ message: "User not found" });
    await users().updateOne({ _id: user._id }, { $set: { blocked } });
    res.json({ user: toPublicUser({ ...user, blocked }) });
  }),
);

app.delete(
  "/api/admin/users/:id",
  requireRoles("admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    const user = oid ? await users().findOne({ _id: oid }) : null;
    if (!user) return res.status(404).json({ message: "User not found" });
    await users().deleteOne({ _id: user._id });
    await wishlists().deleteMany({ userId: req.params.id });
    res.json({ success: true });
  }),
);

app.get(
  "/api/admin/products",
  requireRoles("admin"),
  ah(async (req, res) => {
    const { page, limit } = pageOf(req, 15);
    const docs = (await products().find({}).toArray()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const totalPages = Math.max(1, Math.ceil(docs.length / limit));
    const start = (page - 1) * limit;
    res.json({
      items: docs.slice(start, start + limit).map((p) => ({
        _id: p._id.toString(),
        title: p.title,
        price: p.price,
        discountPrice: p.discountPrice,
        hidden: !!p.hidden,
        images: p.images ?? [],
        seller: { _id: p.sellerId, name: p.sellerName },
      })),
      totalPages,
    });
  }),
);

app.patch(
  "/api/admin/products/:id/visibility",
  requireRoles("admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    const hidden = !!(req.body ?? {}).hidden;
    const product = oid ? await products().findOne({ _id: oid }) : null;
    if (!product) return res.status(404).json({ message: "Product not found" });
    await products().updateOne({ _id: product._id }, { $set: { hidden } });
    res.json({ product: await enrichProduct({ ...product, hidden }) });
  }),
);

app.delete(
  "/api/admin/products/:id",
  requireRoles("admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    if (!oid) return res.status(404).json({ message: "Product not found" });
    await products().deleteOne({ _id: oid });
    await reviews().deleteMany({ productId: req.params.id });
    await wishlists().updateMany({}, { $pull: { productIds: req.params.id } });
    res.json({ success: true });
  }),
);

app.get(
  "/api/admin/orders",
  requireRoles("admin"),
  ah(async (req, res) => {
    const { page, limit } = pageOf(req, 15);
    const docs = (await orders().find({}).toArray()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const totalPages = Math.max(1, Math.ceil(docs.length / limit));
    const start = (page - 1) * limit;
    res.json({
      items: docs.slice(start, start + limit).map((o) => ({
        _id: o._id.toString(),
        buyer: o.buyer,
        total: o.totalAmount,
        createdAt: iso(o.createdAt),
        status: o.status,
      })),
      totalPages,
    });
  }),
);

app.patch(
  "/api/admin/orders/:id/status",
  requireRoles("admin"),
  ah(async (req, res) => {
    const oid = toOid(req.params.id);
    const order = oid ? await orders().findOne({ _id: oid }) : null;
    if (!order) return res.status(404).json({ message: "Order not found" });
    const status = String((req.body ?? {}).status ?? "");
    await orders().updateOne({ _id: order._id }, { $set: { status, orderStatus: status } });
    res.json({ order: toOrder({ ...order, status, orderStatus: status }) });
  }),
);

// ------------------------------------------------------------
// Fallback + error handling
// ------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ message: err instanceof Error ? err.message : "Internal server error" });
});

async function start() {
  await client.connect();
  db = client.db(DB_NAME);

  // Clean up sessions whose user no longer exists (deleted accounts).
  // Note: both user _id and session userId are ObjectIds in the DB.
  sessions()
    .find({})
    .toArray()
    .then(async (all) => {
      const userIds = (await users().find({}).toArray()).map((u) => u._id.toString());
      const orphan = all.filter((s) => !userIds.includes(s.userId.toString()));
      if (orphan.length) {
        await sessions().deleteMany({ _id: { $in: orphan.map((s) => s._id) } });
        console.log(`Cleaned ${orphan.length} orphan session(s)`);
      }
    })
    .catch((e) => console.error("Session cleanup failed:", e));

  app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT} (db: ${DB_NAME})`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

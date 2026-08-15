import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { rateLimit } from "express-rate-limit";
import Stripe from "stripe";
import {MongoClient,ObjectId,ServerApiVersion,type Collection,type Db,type Filter,type WithId} from "mongodb";
import { makeApiUser, makeRequireRoles } from "./auth.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB || "my-shop";

// Stripe is optional. Without STRIPE_SECRET_KEY, order confirmation requires
// ALLOW_DEV_PAYMENT_FALLBACK=true to mark orders paid without verification.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const ALLOW_DEV_PAYMENT_FALLBACK = process.env.ALLOW_DEV_PAYMENT_FALLBACK === "true";

const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled", "refunded"] as const;
const ROLES = ["buyer", "seller", "admin"] as const;

app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000", credentials: true }));
app.use(express.json());

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: {
    message: "Too many requests. Please try again in a few minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

app.use(async (_req: Request, _res: Response, next: NextFunction) => {
  try {
    await ensureStarted();
    next();
  } catch (err) {
    next(err);
  }
});

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
  category?: string | null;
  price: number;
  discountPrice?: number | null;
  stock: number;
  images?: string[] | null;
  description?: string | null;
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
  paymentIntentId?: string;
  createdAt: Date;
  address: { line1?: string; city?: string; state?: string; zip?: string; country?: string };
  contact?: string;
  notes?: string;
}

interface WishlistDoc {
  _id: ObjectId;
  userId: string;
  productIds: string[];
}

const products = (): Collection<ProductDoc> => db.collection<ProductDoc>("products");
const reviews = (): Collection<ReviewDoc> => db.collection<ReviewDoc>("reviews");
const orders = (): Collection<OrderDoc> => db.collection<OrderDoc>("orders");
const wishlists = (): Collection<WishlistDoc> => db.collection<WishlistDoc>("wishlists");
const users = (): Collection<MongoUser> => db.collection<MongoUser>("user");

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const iso = (d?: string | Date) => (d ? new Date(d).toISOString() : undefined);

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
    contact: o.contact,
    notes: o.notes,
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
    category: p.category ?? undefined,
    price: p.price,
    discountPrice: p.discountPrice ?? null,
    stock: p.stock,
    images: p.images ?? [],
    description: p.description ?? undefined,
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
  return { page, limit: Math.min(limit, 100) };
}

// dir=-1 on confirmed payment (stock down, sold up); dir=1 on cancel (restore).
async function adjustStock(order: { items: OrderItemDoc[] }, dir: -1 | 1) {
  for (const item of order.items) {
    const oid = (ObjectId.isValid(item.productId) ? new ObjectId(item.productId) : null);
    if (!oid) continue;
    await products().updateOne({ _id: oid }, { $inc: { stock: dir * item.quantity, sold: -dir * item.quantity } });
  }
}

// ------------------------------------------------------------
// Auth — verifies the better-auth JWT from the `Authorization:
// Bearer` header against the remote JWKS served by the Next.js
// app (CLIENT_URL/api/auth/jwks). No session collection lookup.
// ------------------------------------------------------------

interface SessionDoc {
  _id: string;
  token: string;
  expiresAt: string;
  userId: ObjectId;
  createdAt?: string;
}

const sessions = (): Collection<SessionDoc> => db.collection<SessionDoc>("session");

const apiUser = makeApiUser<MongoUser>((id: ObjectId) => users().findOne({ _id: id }));
const requireRoles = makeRequireRoles(apiUser);

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------

app.get(
  "/api/products",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
          const sums = new Map<string, number>();
          const counts = new Map<string, number>();
          const grouped = await reviews()
            .find({ productId: { $in: items.map((p) => p._id.toString()) } })
            .toArray();
          for (const r of grouped) {
            sums.set(r.productId, (sums.get(r.productId) ?? 0) + r.rating);
            counts.set(r.productId, (counts.get(r.productId) ?? 0) + 1);
          }
          items = [...items].sort((a, b) => {
            const avgA = (sums.get(a._id.toString()) ?? 0) / (counts.get(a._id.toString()) ?? 1);
            const avgB = (sums.get(b._id.toString()) ?? 0) / (counts.get(b._id.toString()) ?? 1);
            return avgB - avgA || (counts.get(b._id.toString()) ?? 0) - (counts.get(a._id.toString()) ?? 0);
          });
          break;
        }
        default:
          items = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }

      const enriched = [];
      for (const p of items) enriched.push(await enrichProduct(p));
      res.json(await paginate(enriched, page, limit));
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/products/featured",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const docs = await products().find({ hidden: { $ne: true }, featured: true }).toArray();
      const items = [];
      for (const p of docs) items.push(await enrichProduct(p));
      items.sort((a, b) => (b.averageRating ?? 0) - (a.averageRating ?? 0));
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/products/best-sellers",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const docs = await products()
        .find({ hidden: { $ne: true } } as Filter<ProductDoc>)
        .sort({ sold: -1 })
        .limit(8)
        .toArray();
      const items = [];
      for (const p of docs) items.push(await enrichProduct(p));
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/products/categories",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const docs = await products()
        .find({ hidden: { $ne: true }, category: { $exists: true, $ne: "" } } as Filter<ProductDoc>)
        .toArray();
      const counts = new Map<string, number>();
      for (const p of docs) {
        if (!p.category) continue;
        counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
      }
      res.json({ items: [...counts.entries()].map(([name, count]) => ({ name, count })) });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/products/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const product = oid ? await products().findOne({ _id: oid, hidden: { $ne: true } }) : null;
      if (!product) return res.status(404).json({ message: "Product not found" });
      res.json({ product: await enrichProduct(product) });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/products/:id/reviews",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const docs = await reviews()
        .find({ productId: req.params.id })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ items: docs.map(toReview) });
    } catch (err) {
      next(err);
    }
  });

app.post(
  "/api/products/:id/reviews",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const productId = req.params.id;
      const oid = (ObjectId.isValid(productId) ? new ObjectId(productId) : null);
      const product = oid ? await products().findOne({ _id: oid }) : null;
      if (!product) return res.status(404).json({ message: "Product not found" });

      const requestBody = req.body ?? {};

      const rating = Number(requestBody.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({
          message: "Rating must be an integer between 1 and 5",
        });
      }

      const reviewComment = requestBody.comment;
      if (typeof reviewComment !== "string") {
        return res.status(400).json({
          message: "Invalid review",
        });
      }
      const trimmedComment = reviewComment.trim();
      if (trimmedComment.length > 1000) {
        return res.status(400).json({
          message: "Review is too long",
        });
      }

      const userId = user._id.toString();
      const bought = await orders().findOne({
        "buyer._id": userId,
        items: { $elemMatch: { productId } },
        status: { $ne: "cancelled" },
      });
      if (!bought) {
        return res.status(403).json({ message: "Only verified buyers can review this product" });
      }
      const existing = await reviews().findOne({ productId, userId });
      if (existing) {
        return res.status(400).json({ message: "You already reviewed this product" });
      }

      const review: ReviewDoc = {
        _id: new ObjectId(),
        productId,
        userId,
        rating,
        comment: trimmedComment,
        createdAt: new Date(),
        user: { _id: userId, name: user.name, photo: user.image ?? user.photo },
      };
      await reviews().insertOne(review);
      res.json({ review: toReview(review) });
    } catch (err) {
      next(err);
    }
  });

// ------------------------------------------------------------
// Wishlist
// ------------------------------------------------------------

app.get(
  "/api/wishlist",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const doc = await wishlists().findOne({ userId: user._id.toString() });
      const ids = (doc?.productIds ?? []).map((id) => (ObjectId.isValid(id) ? new ObjectId(id) : null)).filter((x): x is ObjectId => x !== null);
      const docs = ids.length
        ? await products().find({ _id: { $in: ids }, hidden: { $ne: true } }).toArray()
        : [];
      const items = [];
      for (const p of docs) items.push(await enrichProduct(p));
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

app.post(
  "/api/wishlist",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const productId = String((req.body ?? {}).productId ?? "");
      if (!productId) return res.status(400).json({ message: "productId is required" });
      const oid = (ObjectId.isValid(productId) ? new ObjectId(productId) : null);
      const product = oid ? await products().findOne({ _id: oid }) : null;
      if (!product) return res.status(400).json({ message: "Product not found" });
      const userId = user._id.toString();
      await wishlists().updateOne(
        { userId },
        { $addToSet: { productIds: productId } },
        { upsert: true },
      );
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

app.delete(
  "/api/wishlist/:productId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      await wishlists().updateOne(
        { userId: user._id.toString() },
        { $pull: { productIds: req.params.productId } },
      );
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

// ------------------------------------------------------------
// Orders
// ------------------------------------------------------------

app.post(
  "/api/orders/checkout",
  checkoutLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });

      const requestBody = req.body ?? {};

      const rawItems = requestBody.items;
      if (!Array.isArray(rawItems) || rawItems.length < 1) {
        return res.status(400).json({
          message: "Cart is empty",
        });
      }
      if (rawItems.length > 100) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }

      const validatedItems: { product: string; quantity: number }[] = [];
      for (const rawItem of rawItems) {
        if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) {
          return res.status(400).json({
            message: "Invalid checkout payload",
          });
        }
        if (typeof rawItem.product !== "string" || rawItem.product.trim() === "") {
          return res.status(400).json({
            message: "Invalid checkout payload",
          });
        }
        const quantity = Number(rawItem.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          return res.status(400).json({
            message: "Quantity must be >= 1",
          });
        }
        validatedItems.push({ product: rawItem.product, quantity });
      }

      let addressData:
        | {
            line1?: string;
            city?: string;
            state?: string;
            zip?: string;
            country?: string;
          }
        | undefined;
      const rawAddress = requestBody.address;
      if (typeof rawAddress === "object" && rawAddress !== null && !Array.isArray(rawAddress)) {
        addressData = {
          line1: typeof rawAddress.line1 === "string" ? rawAddress.line1 : undefined,
          city: typeof rawAddress.city === "string" ? rawAddress.city : undefined,
          state: typeof rawAddress.state === "string" ? rawAddress.state : undefined,
          zip: typeof rawAddress.zip === "string" ? rawAddress.zip : undefined,
          country: typeof rawAddress.country === "string" ? rawAddress.country : undefined,
        };
      }

      const addressLine1 = addressData?.line1;
      if (addressLine1 && addressLine1.length > 200) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }
      const addressCity = addressData?.city;
      if (addressCity && addressCity.length > 100) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }
      const addressState = addressData?.state;
      if (addressState && addressState.length > 100) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }
      const addressZip = addressData?.zip;
      if (addressZip && addressZip.length > 40) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }
      const addressCountry = addressData?.country;
      if (addressCountry && addressCountry.length > 100) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }

      const contactNumber =
        typeof requestBody.contact === "string" ? requestBody.contact : undefined;
      if (contactNumber !== undefined && contactNumber.length > 100) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }

      const orderNotes = typeof requestBody.notes === "string" ? requestBody.notes : undefined;
      if (orderNotes !== undefined && orderNotes.length > 2000) {
        return res.status(400).json({
          message: "Invalid checkout payload",
        });
      }

      const items: OrderItemDoc[] = [];
      for (const cartItem of validatedItems) {
        const oid = (ObjectId.isValid(cartItem.product) ? new ObjectId(cartItem.product) : null);
        const product = oid ? await products().findOne({ _id: oid, hidden: { $ne: true } }) : null;
        if (!product) {
          return res.status(400).json({ message: `Product no longer available: ${cartItem.product}` });
        }
        if (cartItem.quantity > product.stock) {
          return res.status(400).json({ message: `Only ${product.stock} left in stock for "${product.title}"` });
        }
        const productPrice = product.discountPrice ?? product.price;
        items.push({
          productId: cartItem.product,
          title: product.title,
          image: product.images?.[0],
          price: productPrice,
          quantity: cartItem.quantity,
          seller: { _id: product.sellerId, name: product.sellerName },
        });
      }

      const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
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
          line1: addressData?.line1 ?? "123 Main St",
          city: addressData?.city ?? "Portland",
          state: addressData?.state,
          zip: addressData?.zip,
          country: addressData?.country ?? "United States",
        },
        contact: contactNumber,
        notes: orderNotes,
      };
      await orders().insertOne(order);

      // The client creates a Stripe Checkout Session (Next.js route) and
      // redirects the buyer to the hosted payment page. Confirmation happens
      // in POST /orders/:id/confirm once Stripe redirects back to /success.
      // Prices below are the authoritative, server-computed ones — the client
      // must build the Stripe session from this response, not from local state.
      res.json({
        orderId: order._id.toString(),
        status: "pending",
        totalAmount,
        items: items.map((item) => ({ title: item.title, image: item.image, price: item.price, quantity: item.quantity })),
      });
    } catch (err) {
      next(err);
    }
  });

app.post(
  "/api/orders/:id/confirm",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const order = oid ? await orders().findOne({ _id: oid }) : null;
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.buyer._id.toString() !== user._id.toString()) {
        return res.status(403).json({ message: "Not your order" });
      }
      if (order.status === "cancelled") {
        return res.status(400).json({ message: "Order was cancelled" });
      }
      if (order.paymentStatus === "paid") {
        return res.json({ order: toOrder(order) });
      }

      const sessionId = String((req.body ?? {}).sessionId ?? "");

      if (stripe) {
        if (!sessionId) {
          return res.status(400).json({ message: "Payment session is required" });
        }
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") {
          return res.status(400).json({ message: `Payment not completed (${session.payment_status})` });
        }
        if (session.metadata?.orderId !== order._id.toString()) {
          return res.status(400).json({ message: "Session does not match this order" });
        }
        if (session.amount_total != null && session.amount_total !== Math.round(order.totalAmount * 100)) {
          return res.status(400).json({ message: "Payment amount does not match order total" });
        }

        const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : undefined;
        await orders().updateOne(
          { _id: order._id },
          {
            $set: {
              paymentStatus: "paid",
              status: "processing",
              orderStatus: "processing",
              ...(paymentIntentId ? { paymentIntentId } : {}),
            },
          },
        );
        await adjustStock(order, -1);
        return res.json({
          order: toOrder({
            ...order,
            paymentStatus: "paid",
            status: "processing",
            orderStatus: "processing",
            paymentIntentId,
          }),
        });
      }

      // Keyless dev fallback — only when explicitly enabled.
      if (!ALLOW_DEV_PAYMENT_FALLBACK) {
        return res.status(400).json({ message: "Payment verification is unavailable" });
      }
      await orders().updateOne(
        { _id: order._id },
        { $set: { paymentStatus: "paid", status: "processing", orderStatus: "processing" } },
      );
      await adjustStock(order, -1);
      res.json({
        order: toOrder({ ...order, paymentStatus: "paid", status: "processing", orderStatus: "processing" }),
      });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/orders/my",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

app.post(
  "/api/orders/:id/cancel",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const order = oid ? await orders().findOne({ _id: oid }) : null;
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.buyer._id.toString() !== user._id.toString()) {
        return res.status(403).json({ message: "Not your order" });
      }
      if (order.status === "cancelled") {
        return res.json({ order: toOrder(order) });
      }

      let paymentStatus = order.paymentStatus;
      if (order.paymentStatus === "paid") {
        if (stripe && order.paymentIntentId) {
          try {
            await stripe.refunds.create({ payment_intent: order.paymentIntentId });
          } catch (e) {
            return res.status(502).json({
              message: e instanceof Error ? `Refund failed: ${e.message}` : "Refund failed",
            });
          }
          paymentStatus = "refunded";
        } else {
          paymentStatus = "refunded"; // keyless dev fallback — no live refund issued
        }
      }

      await orders().updateOne(
        { _id: order._id },
        { $set: { status: "cancelled", orderStatus: "cancelled", paymentStatus } },
      );
      await adjustStock(order, 1);
      res.json({
        order: toOrder({ ...order, status: "cancelled", orderStatus: "cancelled", paymentStatus }),
      });
    } catch (err) {
      next(err);
    }
  });

// ------------------------------------------------------------
// Reviews
// ------------------------------------------------------------

app.get(
  "/api/reviews/latest",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

// ------------------------------------------------------------
// Seller
// ------------------------------------------------------------

app.get(
  "/api/seller/overview",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const sellerId = user._id.toString();
      const myProducts = await products().find({ sellerId }).toArray();
      const myOrderDocs = await orders()
        .find({ status: { $ne: "cancelled" }, "items.seller._id": sellerId } as Filter<OrderDoc>)
        .toArray();
      const revenue = myOrderDocs.reduce(
        (s, o) =>
          s +
          o.items
            .filter((i) => i.seller._id === sellerId)
            .reduce((a, i) => a + i.price * i.quantity, 0),
        0,
      );
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
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/seller/analytics",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/seller/products",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const docs = (await products().find({ sellerId: user._id.toString() }).toArray()).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const items = [];
      for (const p of docs) {
        const enriched = await enrichProduct(p);
        items.push({ ...enriched, sold: p.sold ?? 0, hidden: !!p.hidden });
      }
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

app.post(
  "/api/seller/products",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const requestBody = req.body ?? {};

      const rawTitle = requestBody.title;
      if (typeof rawTitle !== "string") {
        return res.status(400).json({
          message: "Title is required",
        });
      }
      const title = rawTitle.trim();
      if (title.length < 1 || title.length > 200) {
        return res.status(400).json({
          message: "Title is required",
        });
      }

      const rawDescription = requestBody.description;
      const description =
        typeof rawDescription === "string" ? rawDescription.trim() : undefined;
      if (description !== undefined && description.length > 5000) {
        return res.status(400).json({
          message: "Invalid product",
        });
      }

      const rawPrice = requestBody.price;
      if (rawPrice === undefined || rawPrice === null) {
        return res.status(400).json({
          message: "Price must be >= 0",
        });
      }
      const price = Number(rawPrice);
      if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
        return res.status(400).json({
          message: "Price must be >= 0",
        });
      }

      const rawDiscountPrice = requestBody.discountPrice;
      let discountPrice: number | null | undefined;
      if (rawDiscountPrice === null) {
        discountPrice = null;
      }
      if (rawDiscountPrice !== undefined && rawDiscountPrice !== null) {
        const parsedDiscountPrice = Number(rawDiscountPrice);
        if (
          !Number.isFinite(parsedDiscountPrice) ||
          parsedDiscountPrice < 0 ||
          parsedDiscountPrice > 1_000_000
        ) {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        discountPrice = parsedDiscountPrice;
      }
      if (discountPrice !== undefined && discountPrice !== null && discountPrice > price) {
        return res.status(400).json({
          message: "discountPrice must not exceed price",
        });
      }

      const rawCategory = requestBody.category;
      const category = typeof rawCategory === "string" ? rawCategory.trim() : undefined;
      if (category !== undefined && category.length > 100) {
        return res.status(400).json({
          message: "Invalid product",
        });
      }

      const rawStock = requestBody.stock;
      if (rawStock === undefined || rawStock === null) {
        return res.status(400).json({
          message: "Stock must be >= 0",
        });
      }
      const stock = Number(rawStock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
        return res.status(400).json({
          message: "Stock must be >= 0",
        });
      }

      const rawImages = requestBody.images;
      let images: string[] | undefined;
      if (rawImages !== undefined) {
        if (!Array.isArray(rawImages) || rawImages.length > 10) {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        images = [];
        for (const rawImage of rawImages) {
          if (typeof rawImage !== "string" || rawImage.trim().length > 2000) {
            return res.status(400).json({
              message: "Invalid product",
            });
          }
          images.push(rawImage.trim());
        }
      }

      const doc: ProductDoc = {
        _id: new ObjectId(),
        title,
        description,
        price,
        discountPrice: discountPrice ?? null,
        category,
        stock,
        images: images ?? [],
        sellerId: user._id.toString(),
        sellerName: user.name,
        createdAt: new Date(),
        sold: 0,
      };
      await products().insertOne(doc);
      res.json({ product: await enrichProduct(doc) });
    } catch (err) {
      next(err);
    }
  });

app.patch(
  "/api/seller/products/:id",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const existing = oid ? await products().findOne({ _id: oid }) : null;
      if (!existing) return res.status(404).json({ message: "Product not found" });
      const requestBody = req.body ?? {};

      const updatedFields: Partial<ProductDoc> = {};

      const rawTitle = requestBody.title;
      if (rawTitle === null) {
        return res.status(400).json({
          message: "Title is required",
        });
      }
      if (rawTitle !== undefined) {
        if (typeof rawTitle !== "string") {
          return res.status(400).json({
            message: "Title is required",
          });
        }
        const title = rawTitle.trim();
        if (title.length < 1 || title.length > 200) {
          return res.status(400).json({
            message: "Title is required",
          });
        }
        updatedFields.title = title;
      }

      const rawDescription = requestBody.description;
      if (rawDescription === null) {
        updatedFields.description = null;
      }
      if (rawDescription !== undefined && rawDescription !== null) {
        if (typeof rawDescription !== "string") {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        const description = rawDescription.trim();
        if (description.length > 5000) {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        updatedFields.description = description;
      }

      const rawPrice = requestBody.price;
      if (rawPrice === null) {
        return res.status(400).json({
          message: "Price must be >= 0",
        });
      }
      if (rawPrice !== undefined) {
        const price = Number(rawPrice);
        if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
          return res.status(400).json({
            message: "Price must be >= 0",
          });
        }
        updatedFields.price = price;
      }

      const rawDiscountPrice = requestBody.discountPrice;
      if (rawDiscountPrice === null) {
        updatedFields.discountPrice = null;
      }
      if (rawDiscountPrice !== undefined && rawDiscountPrice !== null) {
        const discountPrice = Number(rawDiscountPrice);
        if (!Number.isFinite(discountPrice) || discountPrice < 0 || discountPrice > 1_000_000) {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        updatedFields.discountPrice = discountPrice;
      }
      if (
        updatedFields.price !== undefined &&
        updatedFields.discountPrice !== undefined &&
        updatedFields.discountPrice !== null &&
        updatedFields.discountPrice > updatedFields.price
      ) {
        return res.status(400).json({
          message: "discountPrice must not exceed price",
        });
      }

      const rawCategory = requestBody.category;
      if (rawCategory === null) {
        updatedFields.category = null;
      }
      if (rawCategory !== undefined && rawCategory !== null) {
        if (typeof rawCategory !== "string") {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        const category = rawCategory.trim();
        if (category.length > 100) {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        updatedFields.category = category;
      }

      const rawStock = requestBody.stock;
      if (rawStock === null) {
        return res.status(400).json({
          message: "Stock must be >= 0",
        });
      }
      if (rawStock !== undefined) {
        const stock = Number(rawStock);
        if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
          return res.status(400).json({
            message: "Stock must be >= 0",
          });
        }
        updatedFields.stock = stock;
      }

      const rawImages = requestBody.images;
      if (rawImages === null) {
        updatedFields.images = null;
      }
      if (rawImages !== undefined && rawImages !== null) {
        if (!Array.isArray(rawImages) || rawImages.length > 10) {
          return res.status(400).json({
            message: "Invalid product",
          });
        }
        const images: string[] = [];
        for (const rawImage of rawImages) {
          if (typeof rawImage !== "string" || rawImage.trim().length > 2000) {
            return res.status(400).json({
              message: "Invalid product",
            });
          }
          images.push(rawImage.trim());
        }
        updatedFields.images = images;
      }

      await products().updateOne({ _id: existing._id }, { $set: updatedFields });
      const updated = await products().findOne({ _id: existing._id });
      res.json({ product: updated ? await enrichProduct(updated) : null });
    } catch (err) {
      next(err);
    }
  });

app.delete(
  "/api/seller/products/:id",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      if (!oid) return res.status(404).json({ message: "Product not found" });
      await products().deleteOne({ _id: oid });
      await reviews().deleteMany({ productId: req.params.id });
      await wishlists().updateMany({}, { $pull: { productIds: req.params.id } });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

app.patch(
  "/api/seller/products/:id/visibility",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const product = oid ? await products().findOne({ _id: oid }) : null;
      if (!product) return res.status(404).json({ message: "Product not found" });
      if (user.role !== "admin" && product.sellerId !== user._id.toString()) {
        return res.status(403).json({ message: "This product doesn't belong to your shop" });
      }
      const hidden = !!(req.body ?? {}).hidden;
      await products().updateOne({ _id: product._id }, { $set: { hidden } });
      res.json({ product: await enrichProduct({ ...product, hidden }) });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/seller/orders",
  requireRoles("seller", "admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

app.patch(
  "/api/seller/orders/:id/status",
  requireRoles("seller"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const order = oid ? await orders().findOne({ _id: oid }) : null;
      if (!order) return res.status(404).json({ message: "Order not found" });
      const ownsItem = order.items.some((i) => i.seller._id === user._id.toString());
      if (!ownsItem) return res.status(403).json({ message: "Order has no items from your shop" });

      const currentStatus = (req.body ?? {}).status;
      if (
        typeof currentStatus !== "string" ||
        !(ORDER_STATUSES as readonly string[]).includes(currentStatus)
      ) {
        return res.status(400).json({
          message: `Status must be one of: ${ORDER_STATUSES.join(", ")}`,
        });
      }
      await orders().updateOne(
        { _id: order._id },
        { $set: { status: currentStatus, orderStatus: currentStatus } },
      );
      res.json({
        order: toOrder({ ...order, status: currentStatus, orderStatus: currentStatus }),
      });
    } catch (err) {
      next(err);
    }
  });

app.post(
  "/api/seller/apply",
  requireRoles("seller", "admin"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ applied: true });
    } catch (err) {
      next(err);
    }
  });

// ------------------------------------------------------------
// Admin
// ------------------------------------------------------------

app.get(
  "/api/admin/overview",
  requireRoles("admin"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/admin/users",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

app.patch(
  "/api/admin/users/:id/role",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestedRole = (req.body ?? {}).role;
      if (
        typeof requestedRole !== "string" ||
        !(ROLES as readonly string[]).includes(requestedRole)
      ) {
        return res.status(400).json({
          message: `Role must be one of: ${ROLES.join(", ")}`,
        });
      }
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const user = oid ? await users().findOne({ _id: oid }) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      await users().updateOne({ _id: user._id }, { $set: { role: requestedRole } });
      res.json({ user: toPublicUser({ ...user, role: requestedRole }) });
    } catch (err) {
      next(err);
    }
  });

app.patch(
  "/api/admin/users/:id/block",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const blocked = !!(req.body ?? {}).blocked;
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const user = oid ? await users().findOne({ _id: oid }) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      await users().updateOne({ _id: user._id }, { $set: { blocked } });
      res.json({ user: toPublicUser({ ...user, blocked }) });
    } catch (err) {
      next(err);
    }
  });

app.delete(
  "/api/admin/users/:id",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const admin = await apiUser(req, res);
      if (!admin) return res.status(401).json({ message: "Not authenticated" });
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const user = oid ? await users().findOne({ _id: oid }) : null;
      if (!user) return res.status(404).json({ message: "User not found" });
      if (user._id.equals(admin._id)) {
        return res.status(400).json({ message: "You cannot delete your own account" });
      }
      const userId = req.params.id;
      await users().deleteOne({ _id: user._id });
      await wishlists().deleteMany({ userId });
      await sessions().deleteMany({ userId: user._id });
      await reviews().deleteMany({ userId });
      const theirProducts = await products().find({ sellerId: userId }).toArray();
      const productIds = theirProducts.map((p) => p._id.toString());
      await products().deleteMany({ sellerId: userId });
      if (productIds.length) {
        await reviews().deleteMany({ productId: { $in: productIds } });
        await wishlists().updateMany({}, { $pull: { productIds: { $in: productIds } } });
      }
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/admin/products",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

app.patch(
  "/api/admin/products/:id/visibility",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      const hidden = !!(req.body ?? {}).hidden;
      const product = oid ? await products().findOne({ _id: oid }) : null;
      if (!product) return res.status(404).json({ message: "Product not found" });
      await products().updateOne({ _id: product._id }, { $set: { hidden } });
      res.json({ product: await enrichProduct({ ...product, hidden }) });
    } catch (err) {
      next(err);
    }
  });

app.delete(
  "/api/admin/products/:id",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oid = (ObjectId.isValid(req.params.id) ? new ObjectId(req.params.id) : null);
      if (!oid) return res.status(404).json({ message: "Product not found" });
      await products().deleteOne({ _id: oid });
      await reviews().deleteMany({ productId: req.params.id });
      await wishlists().updateMany({}, { $pull: { productIds: req.params.id } });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

app.get(
  "/api/admin/orders",
  requireRoles("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

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

let startedPromise: Promise<void> | null = null;

function ensureStarted(): Promise<void> {
  if (!startedPromise) {
    startedPromise = start();
  }
  return startedPromise;
}

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

  if (process.env.VERCEL !== "1") {
    app.listen(PORT, () => {
      console.log(`API running on http://localhost:${PORT} (db: ${DB_NAME})`);
    });
  }
}

if (process.env.VERCEL !== "1") {
  ensureStarted().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

export default app;

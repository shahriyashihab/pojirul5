import { Product, Order, CustomerDue, ShopExpense, StockInRecord, DailyCashRecord, ShopSettings, Neighborhood, DuePaymentRecord, ResetOptions } from '../types';
import { INITIAL_PRODUCTS, INITIAL_EXPENSES, INITIAL_CUSTOMERS_DUE, INITIAL_SETTINGS, INITIAL_STOCK_IN, INITIAL_NEIGHBORHOODS } from './initialData';

const FIREBASE_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FIREBASE_BASE_URL) || 'https://pjri-e771a-default-rtdb.firebaseio.com';

// LocalStorage Keys for reliable offline caching and fast initial render
const STORAGE_KEYS = {
  PRODUCTS: 'bb_products_v1',
  ORDERS: 'bb_orders_v1',
  CUSTOMERS_DUE: 'bb_customers_due_v1',
  EXPENSES: 'bb_expenses_v1',
  STOCK_IN: 'bb_stock_in_v1',
  DAILY_CASH: 'bb_daily_cash_v1',
  SETTINGS: 'bb_settings_v1',
  NEIGHBORHOODS: 'bb_neighborhoods_v1',
  AUTH: 'bb_admin_session_v1',
};

// Generic REST request with timeout
async function rtdbFetch<T>(path: string, options?: RequestInit): Promise<T | null> {
  const url = `${FIREBASE_BASE_URL}/${path}.json`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`Firebase RTDB error at ${path}: ${res.statusText}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`Firebase RTDB network error for ${path}:`, err);
    return null;
  }
}

export const FirebaseService = {
  // --- PRODUCTS ---
  async getProducts(): Promise<Product[]> {
    const remote = await rtdbFetch<Record<string, Product> | Product[]>('products');
    if (remote) {
      const list: Product[] = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
      if (list.length > 0) {
        localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(list));
        return list;
      }
    }
    const cached = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    await this.saveProducts(INITIAL_PRODUCTS);
    return INITIAL_PRODUCTS;
  },

  async saveProducts(products: Product[]): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
    const map: Record<string, Product> = {};
    products.forEach((p) => {
      map[p.id] = p;
    });
    await rtdbFetch('products', {
      method: 'PUT',
      body: JSON.stringify(map),
    });
  },

  async updateProduct(product: Product): Promise<void> {
    const current = await this.getProducts();
    const idx = current.findIndex((p) => p.id === product.id);
    let updated: Product[];
    if (idx >= 0) {
      updated = [...current];
      updated[idx] = product;
    } else {
      updated = [product, ...current];
    }
    await this.saveProducts(updated);
  },

  // --- NEIGHBORHOODS (পাড়া ও মহল্লা) ---
  async getNeighborhoods(): Promise<Neighborhood[]> {
    const remote = await rtdbFetch<Record<string, Neighborhood> | Neighborhood[]>('neighborhoods');
    if (remote) {
      const list: Neighborhood[] = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
      if (list.length > 0) {
        localStorage.setItem(STORAGE_KEYS.NEIGHBORHOODS, JSON.stringify(list));
        return list;
      }
    }
    const cached = localStorage.getItem(STORAGE_KEYS.NEIGHBORHOODS);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    await this.saveNeighborhoods(INITIAL_NEIGHBORHOODS);
    return INITIAL_NEIGHBORHOODS;
  },

  async saveNeighborhoods(list: Neighborhood[]): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.NEIGHBORHOODS, JSON.stringify(list));
    const map: Record<string, Neighborhood> = {};
    list.forEach((n) => {
      map[n.id] = n;
    });
    await rtdbFetch('neighborhoods', {
      method: 'PUT',
      body: JSON.stringify(map),
    });
  },

  async addNeighborhood(name: string, description?: string): Promise<Neighborhood> {
    const current = await this.getNeighborhoods();
    const newNeighborhood: Neighborhood = {
      id: `neigh-${Date.now()}`,
      name: name.trim(),
      description: description?.trim() || '',
      createdAt: new Date().toISOString(),
    };
    const updated = [...current, newNeighborhood];
    await this.saveNeighborhoods(updated);
    return newNeighborhood;
  },

  async updateNeighborhood(neighborhood: Neighborhood): Promise<void> {
    const current = await this.getNeighborhoods();
    const updated = current.map((n) => (n.id === neighborhood.id ? neighborhood : n));
    await this.saveNeighborhoods(updated);
  },

  async deleteNeighborhood(id: string): Promise<void> {
    const current = await this.getNeighborhoods();
    const updated = current.filter((n) => n.id !== id);
    await this.saveNeighborhoods(updated);
  },

  // --- ORDERS ---
  async getOrders(): Promise<Order[]> {
    const remote = await rtdbFetch<Record<string, Order> | Order[]>('orders');
    if (remote) {
      const list: Order[] = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(list));
      return list;
    }
    const cached = localStorage.getItem(STORAGE_KEYS.ORDERS);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    return [];
  },

  async createOrder(order: Order): Promise<void> {
    // 1. Save order to RTDB & local storage
    await rtdbFetch(`orders/${order.id}`, {
      method: 'PUT',
      body: JSON.stringify(order),
    });

    // 2. ONLY if order is already confirmed (e.g. if explicitly created as confirmed), deduct stock & record customer purchase
    if (order.status === 'confirmed') {
      await this.deductStockForOrder(order);
      await this.recordCustomerPurchase(order);
    }

    // Update local cache
    const currentOrders = await this.getOrders();
    const updatedOrders = [order, ...currentOrders.filter((o) => o.id !== order.id)];
    localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(updatedOrders));
  },

  async deductStockForOrder(order: Order): Promise<void> {
    const products = await this.getProducts();
    let productsModified = false;
    const updatedProducts = products.map((prod) => {
      const item = order.items.find((i) => i.productId === prod.id);
      if (item) {
        productsModified = true;
        const newStock = Math.max(0, prod.stockKg - item.quantityKg);
        return { ...prod, stockKg: newStock };
      }
      return prod;
    });

    if (productsModified) {
      await this.saveProducts(updatedProducts);
    }
  },

  // অর্ডার বাতিল করা হলে পূর্বে কাটা স্টক পুনরায় গুদামে ফিরিয়ে দেওয়া
  async restoreStockForOrder(order: Order): Promise<void> {
    const products = await this.getProducts();
    let productsModified = false;
    const updatedProducts = products.map((prod) => {
      const item = order.items.find((i) => i.productId === prod.id);
      if (item) {
        productsModified = true;
        const newStock = prod.stockKg + item.quantityKg;
        return { ...prod, stockKg: newStock };
      }
      return prod;
    });

    if (productsModified) {
      await this.saveProducts(updatedProducts);
    }
  },

  // অর্ডার বাতিল হলে কাস্টমার খতিয়ান ও বাকি থেকে সেই মেমোর হিসাব প্রত্যাহার
  async rollbackCustomerPurchase(order: Order): Promise<void> {
    const dues = await this.getCustomersDue();
    const existing = dues.find((c) => {
      if (order.phone && c.phone && order.phone.length > 5 && c.phone.trim() === order.phone.trim()) {
        return true;
      }
      return (
        c.customerName.trim().toLowerCase() === order.customerName.trim().toLowerCase() &&
        (c.moholla === order.moholla || !order.moholla || !c.moholla)
      );
    });

    if (!existing) return;

    const updatedHistory = (existing.history || []).filter((h) => h.memoNo !== order.memoNo);
    const updatedDue: CustomerDue = {
      ...existing,
      totalDue: Math.max(0, (existing.totalDue || 0) - (order.dueAmount || 0)),
      lifetimePurchases: Math.max(0, (existing.lifetimePurchases || 0) - (order.totalAmount || 0)),
      history: updatedHistory,
    };
    const updatedList = dues.map((c) => (c.id === existing.id ? updatedDue : c));
    await this.saveCustomersDue(updatedList);
  },

  // ওয়ান-ক্লিক কনফার্মেশন: সরাসরি অর্ডার কনফার্ম করে স্টক কমায় ও কাস্টমার ডিরেক্টরি/লেজারে নগদ বা বাকির হিসাব এন্ট্রি দেয়
  async confirmOrder(orderId: string): Promise<void> {
    const orders = await this.getOrders();
    const targetOrder = orders.find((o) => o.id === orderId);
    if (!targetOrder) return;

    if (targetOrder.status === 'confirmed') {
      return; // Already confirmed
    }

    const now = new Date().toISOString();
    const confirmedOrder: Order = {
      ...targetOrder,
      status: 'confirmed',
      updatedAt: now,
    };

    // 1. Update order in RTDB
    await rtdbFetch(`orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'confirmed', updatedAt: now }),
    });

    // 2. Deduct product stock
    await this.deductStockForOrder(confirmedOrder);

    // 3. Record customer purchase (whether নগদ cash or বাকি due) so all customers are tracked
    await this.recordCustomerPurchase(confirmedOrder);

    // Update local orders cache
    const updated = orders.map((o) => (o.id === orderId ? confirmedOrder : o));
    localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(updated));
  },

  async updateOrder(order: Order): Promise<void> {
    const orders = await this.getOrders();
    const now = new Date().toISOString();
    const orderToSave = { ...order, updatedAt: now };
    const updated = orders.map((o) => (o.id === order.id ? orderToSave : o));
    localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(updated));
    await rtdbFetch(`orders/${order.id}`, {
      method: 'PUT',
      body: JSON.stringify(orderToSave),
    });
  },

  async updateOrderStatus(orderId: string, status: Order['status']): Promise<void> {
    const orders = await this.getOrders();
    const targetOrder = orders.find((o) => o.id === orderId);
    if (!targetOrder) return;

    if (status === 'confirmed') {
      await this.confirmOrder(orderId);
      return;
    }

    if (status === 'cancelled') {
      // যদি আগে কনফার্ম করা হয়ে থাকে, তবে স্টক ও কাস্টমার হিসাব রোলব্যাক করতে হবে
      if (targetOrder.status === 'confirmed') {
        await this.restoreStockForOrder(targetOrder);
        await this.rollbackCustomerPurchase(targetOrder);
      }
    }

    const now = new Date().toISOString();
    await rtdbFetch(`orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, updatedAt: now }),
    });

    const updated = orders.map((o) => (o.id === orderId ? { ...o, status, updatedAt: now } : o));
    localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(updated));
  },

  // --- CUSTOMER DIRECTORY & DUE LEDGER ---
  async getCustomersDue(): Promise<CustomerDue[]> {
    let list: CustomerDue[] = [];
    const remote = await rtdbFetch<Record<string, CustomerDue> | CustomerDue[]>('customers_due');
    if (remote) {
      list = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
    } else {
      const cached = localStorage.getItem(STORAGE_KEYS.CUSTOMERS_DUE);
      if (cached) {
        try {
          list = JSON.parse(cached);
        } catch (e) {
          console.error(e);
        }
      }
      if (list.length === 0) {
        list = INITIAL_CUSTOMERS_DUE;
      }
    }

    // Auto-reconcile all customers from orders (both cash and due, online and POS)
    const reconciled = this.reconcileCustomersFromOrders(list);
    localStorage.setItem(STORAGE_KEYS.CUSTOMERS_DUE, JSON.stringify(reconciled));
    return reconciled;
  },

  reconcileCustomersFromOrders(dues: CustomerDue[]): CustomerDue[] {
    try {
      const rawOrders = localStorage.getItem(STORAGE_KEYS.ORDERS);
      if (!rawOrders) return dues;
      const orders: Order[] = JSON.parse(rawOrders);
      if (!Array.isArray(orders)) return dues;

      const updated = [...dues];
      orders.forEach((ord) => {
        if (!ord.customerName || ord.status !== 'confirmed') return;

        const existing = updated.find((c) => {
          if (ord.phone && c.phone && ord.phone.length > 5 && c.phone.trim() === ord.phone.trim()) {
            return true;
          }
          return (
            c.customerName.trim().toLowerCase() === ord.customerName.trim().toLowerCase() &&
            (c.moholla === ord.moholla || !ord.moholla || !c.moholla)
          );
        });

        const today = ord.createdAt?.split('T')[0] || new Date().toISOString().split('T')[0];
        const isDue = (ord.dueAmount || 0) > 0;
        const recordType: DuePaymentRecord['type'] = isDue ? 'sale_due' : 'cash_sale';

        if (existing) {
          // If this memo isn't in customer history, record it
          const hasMemo = (existing.history || []).some((h) => h.memoNo && h.memoNo === ord.memoNo);
          if (!hasMemo && ord.status === 'confirmed') {
            const newRec: DuePaymentRecord = {
              id: `rec-${ord.id}`,
              date: today,
              type: recordType,
              amount: isDue ? ord.dueAmount : ord.paidAmount,
              memoNo: ord.memoNo,
              note: isDue
                ? `অর্ডার ক্রয় [বকেয়া: ৳${ord.dueAmount}, জমা: ৳${ord.paidAmount}]`
                : `সম্পূর্ণ নগদ বিক্রয় (পরিশোধিত)`,
            };
            existing.history = [newRec, ...(existing.history || [])];
          }
        } else {
          // New customer from order (cash or due)
          const newRec: DuePaymentRecord = {
            id: `rec-${ord.id}`,
            date: today,
            type: recordType,
            amount: isDue ? ord.dueAmount : ord.paidAmount,
            memoNo: ord.memoNo,
            note: isDue
              ? `অর্ডার ক্রয় [বকেয়া: ৳${ord.dueAmount}, জমা: ৳${ord.paidAmount}]`
              : `সম্পূর্ণ নগদ বিক্রয় (পরিশোধিত)`,
          };

          const newCustomer: CustomerDue = {
            id: `cust-order-${ord.id}`,
            customerName: ord.customerName,
            fatherOrFarmName: ord.customerNickName || '',
            phone: ord.phone || '',
            village: ord.villageAddress || `${ord.moholla || ''}`,
            moholla: ord.moholla || 'অন্যান্য',
            totalDue: ord.status === 'confirmed' ? (ord.dueAmount || 0) : 0,
            lifetimePurchases: ord.status === 'confirmed' ? ord.totalAmount : ord.totalAmount,
            lastPaymentDate: ord.paidAmount > 0 ? today : '',
            history: [newRec],
          };
          updated.push(newCustomer);
        }
      });
      return updated;
    } catch (e) {
      console.error('Customer reconciliation error:', e);
      return dues;
    }
  },

  async saveCustomersDue(list: CustomerDue[]): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.CUSTOMERS_DUE, JSON.stringify(list));
    const map: Record<string, CustomerDue> = {};
    list.forEach((c) => {
      map[c.id] = c;
    });
    await rtdbFetch('customers_due', {
      method: 'PUT',
      body: JSON.stringify(map),
    });
  },

  // সর্বজনীন গ্রাহক কেনাকাটা এন্ট্রি (নগদ বা বাকি - উভয় গ্রাহকের হিসাব সংরক্ষণ)
  async recordCustomerPurchase(order: Order): Promise<void> {
    const dues = await this.getCustomersDue();
    // Match by phone (if provided and valid) or name + moholla
    const existing = dues.find((c) => {
      if (order.phone && c.phone && order.phone.length > 5 && c.phone.trim() === order.phone.trim()) {
        return true;
      }
      return (
        c.customerName.trim().toLowerCase() === order.customerName.trim().toLowerCase() &&
        (c.moholla === order.moholla || !order.moholla || !c.moholla)
      );
    });

    const today = order.createdAt?.split('T')[0] || new Date().toISOString().split('T')[0];
    const isDue = (order.dueAmount || 0) > 0;
    const itemsDesc = order.items.map((i) => `${i.productName} ${i.quantityKg} কেজি`).join(', ');

    const newRecord: DuePaymentRecord = {
      id: `due-rec-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      date: today,
      type: isDue ? 'sale_due' : 'cash_sale',
      amount: isDue ? order.dueAmount : order.paidAmount,
      memoNo: order.memoNo,
      note: isDue
        ? `অর্ডার ক্রয় [বকেয়া: ৳${order.dueAmount}, জমা: ৳${order.paidAmount}] (${itemsDesc})`
        : `সম্পূর্ণ নগদ বিক্রয় (${itemsDesc})`,
    };

    if (existing) {
      // Check if this memo has already been added
      const alreadyHasMemo = (existing.history || []).some((h) => h.memoNo && h.memoNo === order.memoNo);

      const updatedDue: CustomerDue = {
        ...existing,
        customerName: order.customerName || existing.customerName,
        fatherOrFarmName: order.customerNickName || existing.fatherOrFarmName,
        phone: order.phone || existing.phone,
        village: order.villageAddress || existing.village,
        moholla: order.moholla || existing.moholla || 'অন্যান্য',
        totalDue: Math.max(0, (existing.totalDue || 0) + (order.dueAmount || 0)),
        lifetimePurchases: (existing.lifetimePurchases || 0) + (order.totalAmount || 0),
        lastPaymentDate: order.paidAmount > 0 ? today : existing.lastPaymentDate,
        history: alreadyHasMemo ? existing.history : [newRecord, ...(existing.history || [])],
      };
      const updatedList = dues.map((c) => (c.id === existing.id ? updatedDue : c));
      await this.saveCustomersDue(updatedList);
    } else {
      const newCustomerDue: CustomerDue = {
        id: `cust-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        customerName: order.customerName,
        fatherOrFarmName: order.customerNickName || '',
        phone: order.phone || '',
        village: order.villageAddress || `${order.moholla || ''}`,
        moholla: order.moholla || 'অন্যান্য',
        totalDue: order.dueAmount || 0,
        lifetimePurchases: order.totalAmount || 0,
        lastPaymentDate: order.paidAmount > 0 ? today : '',
        history: [newRecord],
      };
      await this.saveCustomersDue([newCustomerDue, ...dues]);
    }
  },

  async recordCustomerDueFromOrder(order: Order): Promise<void> {
    return this.recordCustomerPurchase(order);
  },

  async recordDuePayment(customerId: string, amount: number, note?: string): Promise<void> {
    const dues = await this.getCustomersDue();
    const today = new Date().toISOString().split('T')[0];
    const updated = dues.map((c) => {
      if (c.id === customerId) {
        const remaining = Math.max(0, c.totalDue - amount);
        const newRecord: DuePaymentRecord = {
          id: `pay-rec-${Date.now()}`,
          date: today,
          type: 'payment_received',
          amount,
          note: note || 'নগদ বাকি জমা রসিদ',
        };
        return {
          ...c,
          totalDue: remaining,
          lastPaymentDate: today,
          history: [newRecord, ...(c.history || [])],
        };
      }
      return c;
    });
    await this.saveCustomersDue(updated);
  },

  // গ্রাহক অ্যাকাউন্ট একত্রীকরণ (Merge Duplicate Customer Accounts)
  async mergeCustomers(sourceCustomerId: string, targetCustomerId: string): Promise<void> {
    const dues = await this.getCustomersDue();
    const source = dues.find((c) => c.id === sourceCustomerId);
    const target = dues.find((c) => c.id === targetCustomerId);

    if (!source || !target || source.id === target.id) {
      return;
    }

    // Combine history, dues, and purchases
    const mergedHistory = [...(source.history || []), ...(target.history || [])].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const mergedTarget: CustomerDue = {
      ...target,
      totalDue: target.totalDue + source.totalDue,
      lifetimePurchases: (target.lifetimePurchases || 0) + (source.lifetimePurchases || 0),
      fatherOrFarmName: target.fatherOrFarmName || source.fatherOrFarmName,
      phone: target.phone || source.phone,
      history: mergedHistory,
      lastPaymentDate: target.lastPaymentDate || source.lastPaymentDate,
    };

    // Remove source and update target
    const updatedDues = dues
      .filter((c) => c.id !== sourceCustomerId)
      .map((c) => (c.id === targetCustomerId ? mergedTarget : c));

    await this.saveCustomersDue(updatedDues);

    // Also update order references from source name to target name
    const orders = await this.getOrders();
    let ordersModified = false;
    const updatedOrders = orders.map((o) => {
      if (
        o.customerName === source.customerName ||
        (source.phone && o.phone === source.phone)
      ) {
        ordersModified = true;
        return {
          ...o,
          customerName: target.customerName,
          phone: target.phone || o.phone,
          moholla: target.moholla || o.moholla,
        };
      }
      return o;
    });

    if (ordersModified) {
      localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(updatedOrders));
      const map: Record<string, Order> = {};
      updatedOrders.forEach((ord) => {
        map[ord.id] = ord;
      });
      await rtdbFetch('orders', {
        method: 'PUT',
        body: JSON.stringify(map),
      });
    }
  },

  // --- EXPENSES ---
  async getExpenses(): Promise<ShopExpense[]> {
    const remote = await rtdbFetch<Record<string, ShopExpense> | ShopExpense[]>('expenses');
    if (remote) {
      const list: ShopExpense[] = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
      list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(list));
      return list;
    }
    const cached = localStorage.getItem(STORAGE_KEYS.EXPENSES);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    await this.saveExpenses(INITIAL_EXPENSES);
    return INITIAL_EXPENSES;
  },

  async saveExpenses(list: ShopExpense[]): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(list));
    const map: Record<string, ShopExpense> = {};
    list.forEach((e) => {
      map[e.id] = e;
    });
    await rtdbFetch('expenses', {
      method: 'PUT',
      body: JSON.stringify(map),
    });
  },

  async addExpense(expense: ShopExpense): Promise<void> {
    const list = await this.getExpenses();
    const updated = [expense, ...list];
    await this.saveExpenses(updated);
  },

  // --- STOCK IN (PURCHASE ENTRY) ---
  async getStockIns(): Promise<StockInRecord[]> {
    const remote = await rtdbFetch<Record<string, StockInRecord> | StockInRecord[]>('stock_ins');
    if (remote) {
      const list: StockInRecord[] = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
      list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      localStorage.setItem(STORAGE_KEYS.STOCK_IN, JSON.stringify(list));
      return list;
    }
    const cached = localStorage.getItem(STORAGE_KEYS.STOCK_IN);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    await this.saveStockIns(INITIAL_STOCK_IN);
    return INITIAL_STOCK_IN;
  },

  async saveStockIns(list: StockInRecord[]): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.STOCK_IN, JSON.stringify(list));
    const map: Record<string, StockInRecord> = {};
    list.forEach((s) => {
      map[s.id] = s;
    });
    await rtdbFetch('stock_ins', {
      method: 'PUT',
      body: JSON.stringify(map),
    });
  },

  async addStockIn(record: StockInRecord): Promise<void> {
    const list = await this.getStockIns();
    await this.saveStockIns([record, ...list]);

    const products = await this.getProducts();
    const updatedProducts = products.map((p) => {
      if (p.id === record.productId) {
        return {
          ...p,
          stockKg: p.stockKg + record.quantityKg,
          buyPricePerKg: record.buyPricePerKg > 0 ? record.buyPricePerKg : p.buyPricePerKg,
        };
      }
      return p;
    });
    await this.saveProducts(updatedProducts);
  },

  // --- DAILY CASH RECORDS ---
  async getDailyCashRecords(): Promise<DailyCashRecord[]> {
    const remote = await rtdbFetch<Record<string, DailyCashRecord> | DailyCashRecord[]>('daily_cash');
    if (remote) {
      const list: DailyCashRecord[] = Array.isArray(remote)
        ? remote.filter(Boolean)
        : Object.values(remote);
      localStorage.setItem(STORAGE_KEYS.DAILY_CASH, JSON.stringify(list));
      return list;
    }
    const cached = localStorage.getItem(STORAGE_KEYS.DAILY_CASH);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    return [];
  },

  async setDailyOpeningCash(date: string, openingCash: number, notes?: string): Promise<void> {
    const records = await this.getDailyCashRecords();
    const existingIdx = records.findIndex((r) => r.date === date);
    let updated: DailyCashRecord[];
    const entry: DailyCashRecord = {
      id: `cash-${date}`,
      date,
      openingCash,
      notes,
    };
    if (existingIdx >= 0) {
      updated = [...records];
      updated[existingIdx] = entry;
    } else {
      updated = [entry, ...records];
    }
    localStorage.setItem(STORAGE_KEYS.DAILY_CASH, JSON.stringify(updated));
    await rtdbFetch(`daily_cash/${entry.id}`, {
      method: 'PUT',
      body: JSON.stringify(entry),
    });
  },

  // --- SETTINGS ---
  async getSettings(): Promise<ShopSettings> {
    const remote = await rtdbFetch<ShopSettings>('settings');
    if (remote && remote.shopName) {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(remote));
      return remote;
    }
    const cached = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        console.error(e);
      }
    }
    await this.saveSettings(INITIAL_SETTINGS);
    return INITIAL_SETTINGS;
  },

  async saveSettings(settings: ShopSettings): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    await rtdbFetch('settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  },

  // --- গ্র্যানুলার ডেটা রিসেট (চেকবক্স ভিত্তিক নির্দিষ্ট বিষয় রিসেট করা) ---
  async resetSelectedData(
    options: ResetOptions,
    adminIdInput: string,
    passwordInput: string
  ): Promise<{ success: boolean; message: string }> {
    const settings = await this.getSettings();
    const matchId = (adminIdInput.trim() === settings.adminUsername.trim());
    const matchPass = (passwordInput === settings.adminPassword);

    if (!matchId || !matchPass) {
      return {
        success: false,
        message: 'অ্যাডমিন আইডি অথবা পাসওয়ার্ড সঠিক নয়! দয়া করে সঠিক তথ্য দিন।'
      };
    }

    const resetNames: string[] = [];

    // 1. অর্ডার ও বিক্রয় তথ্য
    if (options.resetOrders) {
      localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify([]));
      await rtdbFetch('orders', { method: 'PUT', body: JSON.stringify({}) });
      resetNames.push('সকল অর্ডার ও বিক্রয় তথ্য');
    }

    // 2. কাস্টমার ও বকেয়া খাতা
    if (options.resetCustomersDue) {
      localStorage.setItem(STORAGE_KEYS.CUSTOMERS_DUE, JSON.stringify([]));
      await rtdbFetch('customers_due', { method: 'PUT', body: JSON.stringify({}) });
      resetNames.push('সকল গ্রাহকের প্রোফাইল ও বকেয়া খাতা');
    }

    // 3. দোকান খরচের হিসাব
    if (options.resetExpenses) {
      localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify([]));
      await rtdbFetch('expenses', { method: 'PUT', body: JSON.stringify({}) });
      resetNames.push('সকল দোকান খরচের হিসাব');
    }

    // 4. মোকাম চালান ও পাইকারি খরিদ
    if (options.resetStockIns) {
      localStorage.setItem(STORAGE_KEYS.STOCK_IN, JSON.stringify([]));
      await rtdbFetch('stock_ins', { method: 'PUT', body: JSON.stringify({}) });
      resetNames.push('মোকাম চালান ও স্টক ইন হিস্ট্রি');
    }

    // 5. দৈনিক ক্যাশ রোকার
    if (options.resetDailyCash) {
      localStorage.setItem(STORAGE_KEYS.DAILY_CASH, JSON.stringify([]));
      await rtdbFetch('daily_cash', { method: 'PUT', body: JSON.stringify({}) });
      resetNames.push('দৈনিক ক্যাশ বই ও রোকার হিসাব');
    }

    // 6. পণ্যের স্টক ও ক্যাটালগ প্রাথমিক মানে রিসেট
    if (options.resetProducts) {
      await this.saveProducts(INITIAL_PRODUCTS);
      resetNames.push('পণ্যের মজুত ও তালিকা (প্রাথমিক অবস্থায় রিসেট)');
    }

    // 7. পাড়া ও মহল্লার তালিকা
    if (options.resetNeighborhoods) {
      await this.saveNeighborhoods(INITIAL_NEIGHBORHOODS);
      resetNames.push('পাড়া ও মহল্লার তালিকা (ডিফল্ট তালিকায় রিসেট)');
    }

    if (resetNames.length === 0) {
      return {
        success: false,
        message: 'রিসেটের জন্য কোনো অপশন সিলেক্ট করা হয়নি! অনুগ্রহ করে অন্তত একটি চেকবক্সে টিক দিন।'
      };
    }

    return {
      success: true,
      message: `সফলভাবে রিসেট সম্পন্ন হয়েছে:\n• ${resetNames.join('\n• ')}`
    };
  },

  // --- মাস্টার ডেটা রিসেট (সকল ডেটা মুছে নতুন করে শুরু করা) ---
  async resetAllData(adminIdInput: string, passwordInput: string): Promise<{ success: boolean; message: string }> {
    return this.resetSelectedData(
      {
        resetOrders: true,
        resetCustomersDue: true,
        resetExpenses: true,
        resetStockIns: true,
        resetDailyCash: true,
        resetProducts: true,
        resetNeighborhoods: true,
      },
      adminIdInput,
      passwordInput
    );
  },

  // --- AUTH SESSION ---
  isAdminLoggedIn(): boolean {
    return localStorage.getItem(STORAGE_KEYS.AUTH) === 'true';
  },

  setAdminLoggedIn(val: boolean): void {
    if (val) {
      localStorage.setItem(STORAGE_KEYS.AUTH, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEYS.AUTH);
    }
  },
};

// Bengali Number & Currency Formatter Helper
export function formatTaka(amount: number): string {
  const rounded = Math.round(amount || 0);
  return `৳${rounded.toLocaleString('bn-BD')}`;
}

export function formatNumberBengali(num: number): string {
  return (num || 0).toLocaleString('bn-BD');
}

export function getBengaliDate(isoOrDateString?: string): string {
  if (!isoOrDateString) return '';
  const d = new Date(isoOrDateString);
  if (isNaN(d.getTime())) return isoOrDateString;
  return d.toLocaleDateString('bn-BD', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

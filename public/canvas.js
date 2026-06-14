'use strict';

(function () {
  const canvas = document.getElementById('canvas-space-simulation');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = window.devicePixelRatio || 1;

  // Global Configurator linked to dashboard stats
  window.canvasConfig = {
    speedMultiplier: 1.0,
    baseColor: null,
    densityFactor: 1.0
  };

  const PARTICLE_COLORS = [
    'rgba(6, 182, 212, 0.7)',   // Electric Cyan
    'rgba(0, 112, 243, 0.7)',   // Cobalt Blue
    'rgba(0, 242, 254, 0.7)',   // Aqua Blue
    'rgba(16, 185, 129, 0.7)'   // Emerald Green
  ];
  
  const STREAM_COUNT = 7;
  const PLEXUS_PARTICLE_COUNT = 60;
  const STREAM_PARTICLE_COUNT = 85;

  const particles = [];
  const streams = [];
  const ripples = [];
  const cardElements = []; // Cached bounding boxes for gravity deflection
  
  const mouse = {
    x: null,
    y: null,
    radius: 200,
    swirlForce: 0.12,
    pullForce: 0.06
  };

  // Cache bounding client rects of stats/glass cards for gravitational lenses
  function updateCardBounds() {
    cardElements.length = 0;
    document.querySelectorAll('.stat-card, .glass-card').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        cardElements.push({
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2
        });
      }
    });
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    
    initStreams();
    updateCardBounds();
  }

  function initStreams() {
    streams.length = 0;
    for (let i = 0; i < STREAM_COUNT; i++) {
      const startX = -50;
      const startY = height * (0.35 + Math.random() * 0.55);
      
      const cp1X = width * 0.18;
      const cp1Y = height * (0.15 + Math.random() * 0.45);
      
      const cp2X = width * 0.38;
      const cp2Y = height * (0.05 + Math.random() * 0.35);
      
      const endX = width * 0.6 + Math.random() * (width * 0.1);
      const endY = -50;
      
      streams.push({ startX, startY, cp1X, cp1Y, cp2X, cp2Y, endX, endY });
    }
  }

  function getBezierPoint(t, p0, p1, p2, p3) {
    const cx = 3 * (p1.x - p0.x);
    const bx = 3 * (p2.x - p1.x) - cx;
    const ax = p3.x - p0.x - cx - bx;

    const cy = 3 * (p1.y - p0.y);
    const by = 3 * (p2.y - p1.y) - cy;
    const ay = p3.y - p0.y - cy - by;

    const x = ((ax * t + bx) * t + cx) * t + p0.x;
    const y = ((ay * t + by) * t + cy) * t + p0.y;

    return { x, y };
  }

  // ==========================================================================
  // Upgraded Particle Constructor (Supports Light-speed Bursts)
  // ==========================================================================
  class Particle {
    constructor(type, isBurst = false) {
      this.type = type;
      this.isBurst = isBurst;
      this.reset();
    }

    reset() {
      this.size = 1 + Math.random() * 2;
      this.color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
      this.brightnessBoost = 0;

      if (this.type === 'stream') {
        this.streamIndex = Math.floor(Math.random() * STREAM_COUNT);
        this.t = Math.random();
        this.speed = 0.0007 + Math.random() * 0.0015;
        this.x = 0;
        this.y = 0;
      } else {
        this.x = width * 0.4 + Math.random() * (width * 0.6);
        this.y = Math.random() * height;
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = (Math.random() - 0.5) * 0.5;
        this.baseVx = this.vx;
        this.baseVy = this.vy;
      }
    }

    update() {
      if (this.brightnessBoost > 0) {
        this.brightnessBoost -= 0.04;
      }

      // 1. Interactive Ripple Push
      ripples.forEach(rip => {
        const dx = this.x - rip.x;
        const dy = this.y - rip.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (Math.abs(dist - rip.radius) < 30 && dist > 0) {
          const force = (1 - Math.abs(dist - rip.radius) / 30) * rip.force;
          const pushX = (dx / dist) * force;
          const pushY = (dy / dist) * force;
          
          this.x += pushX;
          this.y += pushY;
          this.brightnessBoost = 1.0;
        }
      });

      // 2. Magnetic Lens gravity deflects around UI Cards
      cardElements.forEach(card => {
        // Apply force if particle approaches card boundary
        const boundaryPadding = 25;
        if (this.x > card.left - boundaryPadding && this.x < card.right + boundaryPadding &&
            this.y > card.top - boundaryPadding && this.y < card.bottom + boundaryPadding) {
          
          // Calculate distance to closest card edge
          const distL = Math.abs(this.x - card.left);
          const distR = Math.abs(this.x - card.right);
          const distT = Math.abs(this.y - card.top);
          const distB = Math.abs(this.y - card.bottom);
          
          const minDist = Math.min(distL, distR, distT, distB);
          const pushForce = (1 - minDist / boundaryPadding) * 1.5;
          
          if (pushForce > 0) {
            if (minDist === distL) this.x -= pushForce;
            else if (minDist === distR) this.x += pushForce;
            else if (minDist === distT) this.y -= pushForce;
            else if (minDist === distB) this.y += pushForce;
          }
        }
      });

      // 3. Mouse Attractor/Vortex Swirl
      if (mouse.x !== null && mouse.y !== null) {
        const dx = mouse.x - this.x;
        const dy = mouse.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < mouse.radius) {
          const factor = (1 - dist / mouse.radius);
          
          const pullX = (dx / dist) * factor * mouse.pullForce;
          const pullY = (dy / dist) * factor * mouse.pullForce;
          
          const swirlX = (-dy / dist) * factor * mouse.swirlForce * 4.5;
          const swirlY = (dx / dist) * factor * mouse.swirlForce * 4.5;
          
          this.x += pullX + swirlX;
          this.y += pullY + swirlY;
        }
      }

      // 4. Natural velocity flow path
      if (this.type === 'stream') {
        const finalSpeed = this.speed * window.canvasConfig.speedMultiplier;
        this.t += finalSpeed;
        
        if (this.t > 1) {
          if (this.isBurst) {
            return false; // Return false to indicate deletion
          }
          this.reset();
          this.t = 0;
        }
        
        const stream = streams[this.streamIndex];
        if (stream) {
          const pt = getBezierPoint(
            this.t,
            { x: stream.startX, y: stream.startY },
            { x: stream.cp1X, y: stream.cp1Y },
            { x: stream.cp2X, y: stream.cp2Y },
            { x: stream.endX, y: stream.endY }
          );
          this.x = pt.x;
          this.y = pt.y;
        }
      } else {
        this.x += this.vx * window.canvasConfig.speedMultiplier;
        this.y += this.vy * window.canvasConfig.speedMultiplier;

        this.vx += (this.baseVx - this.vx) * 0.05;
        this.vy += (this.baseVy - this.vy) * 0.05;

        if (this.x < width * 0.35 || this.x > width + 10) {
          this.vx *= -1;
          this.baseVx *= -1;
        }
        if (this.y < -10 || this.y > height + 10) {
          this.vy *= -1;
          this.baseVy *= -1;
        }
      }
      return true; // Keep active
    }

    draw() {
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);

      // Color binding (checks for warning colors or defaults)
      const baseColor = window.canvasConfig.baseColor || this.color;

      ctx.shadowBlur = this.brightnessBoost > 0 ? 12 : 6;
      ctx.shadowColor = baseColor;
      
      ctx.fillStyle = baseColor.replace('0.7', 0.7 + this.brightnessBoost * 0.3);
      ctx.fill();
      ctx.restore();
    }
  }

  // ==========================================================================
  // Webhook Light-speed Burst Spawning
  // ==========================================================================
  window.triggerCanvasBurst = function () {
    // Generate massive burst of fast particles shooting left-to-right
    const burstCount = 65;
    for (let i = 0; i < burstCount; i++) {
      const p = new Particle('stream', true);
      p.t = 0;
      p.speed = 0.007 + Math.random() * 0.014; // Light speed velocity
      p.size = 2.5 + Math.random() * 2.0;       // Large glowing packet
      p.color = 'rgba(6, 182, 212, 0.9)';       // Bright cyan glow
      p.brightnessBoost = 1.0;
      
      // Select path
      p.streamIndex = Math.floor(Math.random() * STREAM_COUNT);
      particles.push(p);
    }
    console.log(`[Simulation] Light-speed webhook data burst triggered (${burstCount} nodes)`);
  };

  // ==========================================================================
  // Setup & Render loops
  // ==========================================================================
  function init() {
    resize();
    
    for (let i = 0; i < STREAM_PARTICLE_COUNT; i++) {
      particles.push(new Particle('stream'));
    }
    for (let i = 0; i < PLEXUS_PARTICLE_COUNT; i++) {
      particles.push(new Particle('plexus'));
    }

    // Delay bounding query slightly to allow widgets layout paint
    setTimeout(updateCardBounds, 250);
  }

  let nebulaAngle = 0;
  function drawNebulae() {
    nebulaAngle += 0.0006;
    
    // Shift color variables depending on config latency warning
    const colorA = window.canvasConfig.baseColor ? 'rgba(245, 158, 11, 0.03)' : 'rgba(16, 185, 129, 0.03)';
    const colorB = window.canvasConfig.baseColor ? 'rgba(245, 158, 11, 0.01)' : 'rgba(6, 182, 212, 0.01)';
    const colorC = window.canvasConfig.baseColor ? 'rgba(245, 158, 11, 0.04)' : 'rgba(6, 182, 212, 0.04)';

    const auroraX = width * 0.2 + Math.sin(nebulaAngle) * 80;
    const auroraY = height * 0.7 + Math.cos(nebulaAngle) * 80;
    const auroraGrad = ctx.createRadialGradient(auroraX, auroraY, 50, auroraX, auroraY, width * 0.45);
    auroraGrad.addColorStop(0, colorA);
    auroraGrad.addColorStop(0.5, colorB);
    auroraGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = auroraGrad;
    ctx.fillRect(0, 0, width, height);

    const indigoX = width * 0.75 + Math.cos(nebulaAngle * 1.2) * 120;
    const indigoY = height * 0.3 + Math.sin(nebulaAngle * 1.2) * 100;
    const indigoGrad = ctx.createRadialGradient(indigoX, indigoY, 80, indigoX, indigoY, width * 0.5);
    indigoGrad.addColorStop(0, colorC);
    indigoGrad.addColorStop(0.6, 'rgba(0, 112, 243, 0.01)');
    indigoGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = indigoGrad;
    ctx.fillRect(0, 0, width, height);
  }

  function drawPlexusLines() {
    const plexusList = particles.filter(p => p.type === 'plexus');
    
    for (let i = 0; i < plexusList.length; i++) {
      const p1 = plexusList[i];
      for (let j = i + 1; j < plexusList.length; j++) {
        const p2 = plexusList[j];
        
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < 100) {
          const opacity = (1 - dist / 100) * 0.08;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          
          const baseColor = window.canvasConfig.baseColor || 'rgba(6, 182, 212, 1)';
          ctx.strokeStyle = baseColor.replace(/[\d.]+\)$/, `${opacity})`);
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function drawTracePaths() {
    ctx.save();
    ctx.lineWidth = 1;
    streams.forEach(stream => {
      ctx.beginPath();
      ctx.moveTo(stream.startX, stream.startY);
      ctx.bezierCurveTo(stream.cp1X, stream.cp1Y, stream.cp2X, stream.cp2Y, stream.endX, stream.endY);
      
      const grad = ctx.createLinearGradient(0, height, width * 0.5, 0);
      const strokeA = window.canvasConfig.baseColor ? 'rgba(245, 158, 11, 0.01)' : 'rgba(0, 112, 243, 0.015)';
      const strokeB = window.canvasConfig.baseColor ? 'rgba(245, 158, 11, 0.02)' : 'rgba(6, 182, 212, 0.02)';

      grad.addColorStop(0, strokeA);
      grad.addColorStop(0.5, strokeB);
      grad.addColorStop(1, 'rgba(6, 182, 212, 0.005)');
      
      ctx.strokeStyle = grad;
      ctx.stroke();
    });
    ctx.restore();
  }

  function updateRipples() {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rip = ripples[i];
      rip.radius += rip.speed;
      rip.opacity = 1 - (rip.radius / rip.maxRadius);
      
      ctx.save();
      ctx.beginPath();
      ctx.arc(rip.x, rip.y, rip.radius, 0, Math.PI * 2);
      
      const baseColor = window.canvasConfig.baseColor || 'rgba(6, 182, 212, 1)';
      ctx.strokeStyle = baseColor.replace(/[\d.]+\)$/, `${rip.opacity * 0.15})`);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      if (rip.radius >= rip.maxRadius) {
        ripples.splice(i, 1);
      }
    }
  }

  function loop() {
    // Solid background gradient
    const spaceGrad = ctx.createLinearGradient(0, 0, width, height);
    spaceGrad.addColorStop(0, '#040508');
    spaceGrad.addColorStop(1, '#080911');
    ctx.fillStyle = spaceGrad;
    ctx.fillRect(0, 0, width, height);

    drawNebulae();
    drawTracePaths();
    drawPlexusLines();
    updateRipples();

    // Iterate backwards so we can safely delete completed bursts in-loop
    for (let i = particles.length - 1; i >= 0; i--) {
      const active = particles[i].update();
      if (!active) {
        particles.splice(i, 1);
      } else {
        particles[i].draw();
      }
    }

    requestAnimationFrame(loop);
  }

  // Bind mouse variables
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  window.addEventListener('mouseleave', () => {
    mouse.x = null;
    mouse.y = null;
  });

  // Global click shockwave triggers
  window.addEventListener('click', (e) => {
    // Avoid triggering ripple on input elements to preserve UI focus fields
    const targetTag = e.target.tagName.toLowerCase();
    if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'button' || e.target.closest('button')) {
      return;
    }

    ripples.push({
      x: e.clientX,
      y: e.clientY,
      radius: 5,
      maxRadius: 280,
      speed: 6.5,
      opacity: 1,
      force: 22
    });
  });

  // Bind layout bounds resize trackers
  window.addEventListener('resize', () => {
    resize();
  });
  window.addEventListener('scroll', updateCardBounds);

  // Initialize canvas
  init();
  loop();
})();

/*eslint no-magic-numbers: ["error", { "ignore": [-1, 0, 1, 2, 1000] }]*/
import { Children } from "react";
import { Selection, Collection, Data, Helpers, Domain } from "victory-core";
import { assign, throttle, isFunction, defaults } from "lodash";

function getCurrentAxis(axis, horizontal) {
  const otherAxis = axis === "x" ? "y" : "x";
  return horizontal ? otherAxis : axis;
};

function getDomainFromChildren(props, axis, childComponents) {
  const children = childComponents ?
    childComponents.slice(0) : Children.toArray(props.children);
  const horizontalChildren = childComponents.some((component) => {
    return component.props && component.props.horizontal;
  });
  const horizontal = props && props.horizontal || horizontalChildren.length > 0;
  const currentAxis = getCurrentAxis(axis, horizontal);
  const parentData = props.data ? Data.getData(props, axis) : undefined;
  const { polar, startAngle, endAngle, categories, minDomain, maxDomain } = props;
  const baseParentProps = { polar, startAngle, endAngle, categories, minDomain, maxDomain };
  const parentProps = parentData ?
    assign(baseParentProps, { data: parentData }) : baseParentProps;

  const iteratee = (child) => {
    const role = child.type && child.type.role;
    const sharedProps = assign({}, child.props, parentProps);
    if (role === "legend" || role === "label") {
      return null;
    } else if (child.type && isFunction(child.type.getDomain)) {
      return child.props && child.type.getDomain(sharedProps, currentAxis);
    } else {
      return Domain.getDomain(sharedProps, currentAxis);
    }
  };
  const childDomains = Helpers.reduceChildren(children, iteratee, props);

  const min = childDomains.length === 0 ? 0 : Collection.getMinValue(childDomains);
  const max = childDomains.length === 0 ? 1 : Collection.getMaxValue(childDomains);
  return [min, max];
};

const RawZoomHelpers = {
  checkDomainEquality(a, b) {
    const checkDimension = (dim) => {
      const val1 = a && a[dim];
      const val2 = b && b[dim];
      if (!val1 && !val2) {
        return true;
      } else if (!val1 || !val2) {
        return false;
      }
      return +val1[0] === +val2[0] && +val1[1] === +val2[1];
    };
    return checkDimension("x") && checkDimension("y");
  },
  /**
   * Generates a new domain scaled by factor and constrained by the original domain.
   * @param  {[Number, Number]} currentDomain  The domain to be scaled.
   * @param  {Object} evt the event object
   * @param  {Object} props the props of the targeted component
   * @param  {String} axis the desired dimension (either x or y)
   * @return {[Number, Number]}                The scale domain
   */
  scale(currentDomain, evt, props, axis) { // eslint-disable-line max-params
    const [from, to] = currentDomain;
    const range = Math.abs(to - from);
    const minimumZoom = props.minimumZoom && props.minimumZoom[axis];
    const factor = this.getScaleFactor(evt);
    if (minimumZoom && range <= minimumZoom && factor < 1) {
      return currentDomain;
    }
    const [fromBound, toBound] = this.getDomain(props)[axis];
    const percent = this.getScalePercent(evt, props, axis);
    const point = (factor * from) + percent * (factor * range);
    const minDomain = this.getMinimumDomain(point, props, axis);
    const [newMin, newMax] = this.getScaledDomain(currentDomain, factor, percent);
    const newDomain = [
      newMin > fromBound && newMin < toBound ? newMin : fromBound,
      newMax < toBound && newMax > fromBound ? newMax : toBound
    ];
    const domain = Math.abs(minDomain[1] - minDomain[0]) > Math.abs(newDomain[1] - newDomain[0]) ?
      minDomain : newDomain;
    return Collection.containsDates([fromBound, toBound]) ?
      [ new Date(domain[0]), new Date(domain[1]) ] : domain;
  },

  getScaledDomain(currentDomain, factor, percent) {
    const [from, to] = currentDomain;
    const range = Math.abs(to - from);
    const diff = range - (range * factor);
    const newMin = +from + (diff * percent);
    const newMax = +to - (diff * (1 - percent));
    return [ Math.min(newMin, newMax), Math.max(newMin, newMax) ];
  },

  getMinimumDomain(point, props, axis) {
    const { minimumZoom } = props;
    const originalDomain = this.getDomain(props)[axis];
    const [from, to] = originalDomain;
    const defaultMin = Math.abs(from - to) / 1000;
    const extent = minimumZoom ? minimumZoom[axis] || defaultMin : defaultMin;
    const minExtent = point - (extent / 2);
    const maxExtent = point + (extent / 2);
    return [
      minExtent > from && minExtent < to ? minExtent : from,
      maxExtent < to && maxExtent > from ? maxExtent : +from + extent / 2
    ];
  },

  zoommingOut(evt) {
    return evt.deltaY > 0;
  },

  getScaleFactor(evt) {
    const sign = this.zoommingOut(evt) ? 1 : -1;
   // eslint-disable-next-line no-magic-numbers
    const delta = Math.min(Math.abs(evt.deltaY / 300), 0.5); // TODO: Check scale factor
    return Math.abs(1 + sign * delta);
  },

  getScalePercent(evt, props, axis) {
    const originalDomain = this.getDomain(props);
    const [from, to] = originalDomain[axis];
    const position = this.getPosition(evt, props, originalDomain);
    return (position[axis] - from) / Math.abs(to - from);
  },

  getPosition(evt, props, originalDomain) {
    const { x, y } = Selection.getSVGEventCoordinates(evt);
    const originalScale = {
      x: props.scale.x.domain(originalDomain.x),
      y: props.scale.y.domain(originalDomain.y)
    };
    return Selection.getDataCoordinates(props, originalScale, x, y);
  },

  /**
   * Generate a new domain translated by the delta and constrained by the original domain.
   * @param  {[Number, Number]} currentDomain  The domain to be translated.
   * @param  {[Number, Number]} originalDomain The original domain for the data set.
   * @param  {Number}           delta          The delta to translate by
   * @return {[Number, Number]}                The translated domain
   */
  pan(currentDomain, originalDomain, delta) {
    const [fromCurrent, toCurrent] = currentDomain.map((val) => +val);
    const [fromOriginal, toOriginal] = originalDomain.map((val) => +val);
    const lowerBound = fromCurrent + delta;
    const upperBound = toCurrent + delta;
    let newDomain;
    if (lowerBound > fromOriginal && upperBound < toOriginal) {
      newDomain = [lowerBound, upperBound];
    } else if (lowerBound < fromOriginal) { // Clamp to lower limit
      const dx = toCurrent - fromCurrent;
      newDomain = [fromOriginal, fromOriginal + dx];
    } else if (upperBound > toOriginal) { // Clamp to upper limit
      const dx = toCurrent - fromCurrent;
      newDomain = [toOriginal - dx, toOriginal];
    } else {
      newDomain = currentDomain;
    }
    return Collection.containsDates(currentDomain) || Collection.containsDates(originalDomain) ?
      newDomain.map((val) => new Date(val)) : newDomain;
  },

  getDomainScale(domain, scale, axis) {
    const axisDomain = Array.isArray(domain) ? domain : domain[axis];
    const [from, to] = axisDomain;
    const range = scale[axis].range();
    const plottableWidth = Math.abs(range[0] - range[1]);
    return plottableWidth / (to - from);
  },

  handleAnimation(ctx) {
    const getTimer = isFunction(ctx.getTimer) && ctx.getTimer.bind(ctx);
    if (getTimer && isFunction(getTimer().bypassAnimation)) {
      getTimer().bypassAnimation();
      return isFunction(getTimer().resumeAnimation) ?
        () => getTimer().resumeAnimation() : undefined;
    }
    return undefined;
  },

  getLastDomain(targetProps, originalDomain) {
    const { zoomDomain, cachedZoomDomain, currentDomain, domain } = targetProps;
    if (zoomDomain && !this.checkDomainEquality(zoomDomain, cachedZoomDomain)) {
      return defaults(
        {}, zoomDomain, domain
      );
    }
    return defaults(
      {}, currentDomain || zoomDomain || originalDomain, domain
    );
  },

  getDomain(props) {
    const { originalDomain, domain, children, zoomDimension } = props;
    const childComponents = Children.toArray(children);
    let childrenDomain = {};
    if (childComponents.length) {
      childrenDomain = zoomDimension ?
        { [zoomDimension]: getDomainFromChildren(props, zoomDimension, childComponents) }
        : ({
          x: getDomainFromChildren(props, "x", childComponents),
          y: getDomainFromChildren(props, "y", childComponents)
        });
    }
    return defaults({}, childrenDomain, originalDomain, domain);
  },

  onMouseDown(evt, targetProps) {
    evt.preventDefault();
    if (!targetProps.allowPan) {
      return undefined;
    }
    const parentSVG = targetProps.parentSVG || Selection.getParentSVG(evt);
    const { x, y } = Selection.getSVGEventCoordinates(evt, parentSVG);
    return [{
      target: "parent",
      mutation: () => {
        return {
          startX: x, startY: y, panning: true, parentSVG,
          parentControlledProps: ["domain"]
        };
      }
    }];
  },

  onMouseUp(evt, targetProps) {
    if (!targetProps.allowPan) {
      return undefined;
    }
    return [{
      target: "parent",
      mutation: () => {
        return { panning: false };
      }
    }];
  },

  onMouseLeave(evt, targetProps) {
    if (!targetProps.allowPan) {
      return undefined;
    }
    return [{
      target: "parent",
      mutation: () => {
        return { panning: false };
      }
    }];
  },

  onMouseMove(evt, targetProps, eventKey, ctx) { // eslint-disable-line max-params, max-statements
    if (targetProps.panning && targetProps.allowPan) {
      const { scale, startX, startY, onZoomDomainChange, zoomDimension, zoomDomain } = targetProps;
      const parentSVG = targetProps.parentSVG || Selection.getParentSVG(evt);
      const { x, y } = Selection.getSVGEventCoordinates(evt, parentSVG);
      const originalDomain = this.getDomain(targetProps);
      const lastDomain = this.getLastDomain(targetProps, originalDomain);
      const dx = (startX - x) / this.getDomainScale(lastDomain, scale, "x");
      const dy = (y - startY) / this.getDomainScale(lastDomain, scale, "y");
      const currentDomain = {
        x: zoomDimension === "y" ? originalDomain.x : this.pan(lastDomain.x, originalDomain.x, dx),
        y: zoomDimension === "x" ? originalDomain.y : this.pan(lastDomain.y, originalDomain.y, dy)
      };
      const resumeAnimation = this.handleAnimation(ctx);

      const zoomActive = !this.checkDomainEquality(originalDomain, lastDomain);

      const mutatedProps = {
        parentControlledProps: ["domain"], startX: x, startY: y, parentSVG,
        domain: currentDomain, currentDomain, originalDomain, cachedZoomDomain: zoomDomain,
        zoomActive
      };

      if (isFunction(onZoomDomainChange)) {
        onZoomDomainChange(currentDomain, defaults({}, mutatedProps, targetProps));
      }
      return [{
        target: "parent",
        callback: resumeAnimation,
        mutation: () => mutatedProps
      }];
    }
    return undefined;
  },

  onWheel(evt, targetProps, eventKey, ctx) { // eslint-disable-line max-params
    if (!targetProps.allowZoom) {
      return undefined;
    }
    const { onZoomDomainChange, zoomDimension, zoomDomain } = targetProps;
    const originalDomain = this.getDomain(targetProps);
    const lastDomain = this.getLastDomain(targetProps, originalDomain);
    const { x, y } = lastDomain;
    const currentDomain = {
      x: zoomDimension === "y" ? lastDomain.x : this.scale(x, evt, targetProps, "x"),
      y: zoomDimension === "x" ? lastDomain.y : this.scale(y, evt, targetProps, "y")
    };
    const resumeAnimation = this.handleAnimation(ctx);

    const zoomActive = !this.zoommingOut(evt) // if zoomming in or
    //   if zoomActive is already set AND user hasn't zoommed out all the way
      || (targetProps.zoomActive && !this.checkDomainEquality(originalDomain, lastDomain));

    const mutatedProps = {
      domain: currentDomain, currentDomain, originalDomain, cachedZoomDomain: zoomDomain,
      parentControlledProps: ["domain"], panning: false, zoomActive
    };

    if (isFunction(onZoomDomainChange)) {
      onZoomDomainChange(currentDomain, defaults({}, mutatedProps, targetProps));
    }

    return [{
      target: "parent",
      callback: resumeAnimation,
      mutation: () => mutatedProps
    }];
  }
};

export { RawZoomHelpers }; // allow victory-native to extend these helpers

export default {
  checkDomainEquality: RawZoomHelpers.checkDomainEquality.bind(RawZoomHelpers),
  onMouseDown: RawZoomHelpers.onMouseDown.bind(RawZoomHelpers),
  onMouseUp: RawZoomHelpers.onMouseUp.bind(RawZoomHelpers),
  onMouseLeave: RawZoomHelpers.onMouseLeave.bind(RawZoomHelpers),
  onMouseMove: throttle(
    RawZoomHelpers.onMouseMove.bind(RawZoomHelpers),
    16, // eslint-disable-line no-magic-numbers
    { leading: true, trailing: false }
  ),
  onWheel: throttle(
    RawZoomHelpers.onWheel.bind(RawZoomHelpers),
    16, // eslint-disable-line no-magic-numbers
    { leading: true, trailing: false }
  )
};